create or replace function public.decide_case(p_user uuid,p_case uuid,p_action text) returns jsonb language plpgsql set search_path='' as $$
declare c public.packet_cases;
begin
 select * into c from public.packet_cases where id=p_case and owner_user_id=p_user for update;
 if not found then raise exception 'Case not found.'; end if;
 if p_action in ('accept','reject') then
   if c.deleted_at is not null or c.status not in ('completed','accepted','rejected') then raise exception 'Only an analyzed case can be reviewed.'; end if;
   if p_action='accept' and exists(select 1 from public.packet_mismatches where case_id=p_case and field_name='documentReadability') then raise exception 'Approval is blocked until every faint, rotated, blurred, cropped, or unreadable page is replaced and the case is analyzed again.'; end if;
   if p_action='accept' and exists(select 1 from public.packet_mismatches where case_id=p_case and resolution_status<>'accepted') then raise exception 'Review and accept every issue before accepting this case.'; end if;
   update public.packet_cases set status=case p_action when 'accept' then 'accepted' else 'rejected' end where id=p_case returning * into c;
 elsif p_action='recycle' then
   update public.packet_processing_jobs set status='cancelled',stage='Cancelled',finished_at=now(),locked_by=null where case_id=p_case and status in ('queued','running');
   update public.packet_cases set deleted_at=now(),deleted_by_user_id=p_user,status=case when status='processing' then 'draft' else status end where id=p_case returning * into c;
 elsif p_action='restore' then
   update public.packet_cases set deleted_at=null,deleted_by_user_id=null where id=p_case returning * into c;
 elsif p_action='delete' then
   if c.deleted_at is null then raise exception 'Move the case to the recycle bin before permanent deletion.'; end if;
   delete from public.packet_cases where id=p_case;
 else raise exception 'Invalid case action.';
 end if;
 insert into public.case_review_events(case_id,owner_user_id,action) values(p_case,p_user,p_action);
 return to_jsonb(c);
end $$;

create or replace function public.resolve_mismatches(p_user uuid,p_case uuid,p_ids uuid[],p_decision text) returns jsonb language plpgsql set search_path='' as $$
declare c public.packet_cases; result jsonb; next_status text;
begin
 select * into c from public.packet_cases where id=p_case and owner_user_id=p_user and deleted_at is null for update;
 if not found or c.status not in ('completed','accepted','rejected') then raise exception 'This case is not ready for review.'; end if;
 if p_decision not in ('accepted','rejected') or cardinality(p_ids)<1 or (select count(*) from public.packet_mismatches where case_id=p_case and id=any(p_ids))<>cardinality(p_ids) then raise exception 'Invalid issues or decision.'; end if;
 if p_decision='accepted' and exists(select 1 from public.packet_mismatches where case_id=p_case and id=any(p_ids) and field_name='documentReadability') then raise exception 'A document-reading warning cannot be settled. Replace the affected page and analyze the case again.'; end if;
 update public.packet_mismatches set resolution_status=p_decision,resolved_at=now(),resolved_by=p_user where case_id=p_case and id=any(p_ids);
 next_status=case when exists(select 1 from public.packet_mismatches where case_id=p_case and field_name='documentReadability') then 'completed' when not exists(select 1 from public.packet_mismatches where case_id=p_case and resolution_status<>'accepted') then 'accepted' else 'completed' end;
 update public.packet_cases set status=next_status where id=p_case;
 select jsonb_agg(jsonb_build_object('id',id,'resolutionStatus',resolution_status,'resolvedAt',resolved_at)) into result from public.packet_mismatches where case_id=p_case and id=any(p_ids);
 insert into public.case_review_events(case_id,owner_user_id,action,details) values(p_case,p_user,'issues_'||p_decision,jsonb_build_object('issueIds',p_ids));
 return jsonb_build_object('caseStatus',next_status,'mismatches',result);
end $$;
