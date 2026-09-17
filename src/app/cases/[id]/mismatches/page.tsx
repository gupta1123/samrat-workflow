import { CaseMismatchReviewPage } from "@/components/cases/CaseMismatchReviewPage";
import { RuntimeFieldSettingsBootstrap } from "@/components/settings/RuntimeFieldSettingsBootstrap";

export default async function SavedCaseMismatchPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  return (
    <>
      <RuntimeFieldSettingsBootstrap />
      <CaseMismatchReviewPage caseId={id} />
    </>
  );
}
