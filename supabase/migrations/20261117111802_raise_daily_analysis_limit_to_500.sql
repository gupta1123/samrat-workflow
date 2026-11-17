-- Keep the deployed queue function and its grants. Change only its daily cap.
do $migration$
declare
  definition text := pg_get_functiondef(
    'public.enqueue_case_analysis(uuid,uuid,jsonb)'::regprocedure
  );
  old_limit constant text := '>=[[:space:]]*40[[:space:]]+then';
  new_limit constant text := '>=[[:space:]]*500[[:space:]]+then';
begin
  if definition ~ new_limit and definition !~ old_limit then
    return;
  end if;

  if (select count(*) from regexp_matches(definition, old_limit, 'g')) <> 1 then
    raise exception 'Expected one 40-analysis limit in enqueue_case_analysis.';
  end if;

  execute regexp_replace(definition, old_limit, '>=500 then');
end;
$migration$;
