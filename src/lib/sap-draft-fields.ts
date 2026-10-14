export type DraftFieldChoices = { materialForm?: string; transporter?: string };

export type DraftHeaderPreview = {
  service?: boolean;
  fields: Array<{
    key: string;
    label: string;
    value: string | number | null;
    source: string;
  }>;
  materialForm: {
    required?: boolean;
    selectedValue: string;
    options: Array<{ value: string; label: string }>;
  };
  transporter: {
    required?: boolean;
    selectedValue: string;
    options: Array<{ value: string; label: string }>;
  };
  warnings: string[];
};

export function draftSelectionsComplete(
  preview: DraftHeaderPreview,
  choices: DraftFieldChoices,
) {
  return (
    (!(preview.materialForm.required ?? !preview.service) ||
      Boolean(choices.materialForm)) &&
    (!(preview.transporter.required ?? !preview.service) ||
      Boolean(choices.transporter))
  );
}
