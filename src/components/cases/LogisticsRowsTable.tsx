"use client";

import type { LogisticsRow, LogisticsRowField } from "@/types/pipeline";
import styles from "./CaseDetailPage.module.css";

const COLUMNS: Array<{ key: LogisticsRowField; label: string }> = [
  { key: "vehicleNumber", label: "Vehicle / Rail Reference" },
  { key: "transportMode", label: "Mode" },
  { key: "transporterName", label: "Transporter" },
  { key: "documentDate", label: "Date" },
  { key: "lorryReceiptNumber", label: "LR / Transport Document" },
  { key: "deliveryNoteNumber", label: "Delivery Note" },
  { key: "deliveryOrderNumber", label: "Delivery Order" },
  { key: "referenceInvoiceNumber", label: "Invoice Reference" },
  { key: "referencePoNumber", label: "PO Reference" },
  { key: "itemCode", label: "Item Code" },
  { key: "description", label: "Description" },
  { key: "quantity", label: "Quantity" },
  { key: "unit", label: "Quantity Unit" },
  { key: "grossWeight", label: "Gross Weight" },
  { key: "tareWeight", label: "Tare / Packing Weight" },
  { key: "netWeight", label: "Net Weight" },
  { key: "weightUnit", label: "Weight Unit" },
];

export function LogisticsRowsTable({ rows }: { rows: LogisticsRow[] }) {
  return (
    <div className={styles.redesignDataContent}>
      {(["transport", "weighment"] as const).map((kind) => {
        const entries = rows.filter((row) => row.kind === kind);
        if (!entries.length) return null;
        const columns = COLUMNS.filter(({ key }) =>
          entries.some((row) => row.values[key]),
        );
        return (
          <section key={kind}>
            <h3 className={styles.redesignDataGroupLabel}>
              {kind === "transport" ? "Transport entries" : "Weighment rows"} (
              {entries.length})
            </h3>
            <div className={styles.redesignLineTableWrap}>
              <table className={styles.redesignLineTable}>
                <thead>
                  <tr>
                    {columns.map((column) => (
                      <th key={column.key}>{column.label}</th>
                    ))}
                    <th>Source</th>
                  </tr>
                </thead>
                <tbody>
                  {entries.map((row, index) => (
                    <tr key={index}>
                      {columns.map(({ key }) => (
                        <td key={key} title={row.evidence?.[key]}>
                          {row.values[key] ?? "—"}
                        </td>
                      ))}
                      <td>Page {row.sourcePage}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        );
      })}
    </div>
  );
}
