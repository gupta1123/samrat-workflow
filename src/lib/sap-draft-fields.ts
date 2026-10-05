export type DraftFieldChoices = { materialForm?: string; transporter?: string };

export type DraftHeaderPreview = {
  fields: Array<{
    key: string;
    label: string;
    value: string | number | null;
    source: string;
  }>;
  materialForm: {
    selectedValue: string;
    options: Array<{ value: string; label: string }>;
  };
  transporter: {
    selectedValue: string;
    options: Array<{ value: string; label: string }>;
  };
  warnings: string[];
};
