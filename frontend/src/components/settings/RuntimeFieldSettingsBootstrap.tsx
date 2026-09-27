"use client";

import { apiFetch } from "@/lib/api-client";
import { useEffect } from "react";

import {
  buildPacketFieldConfiguration,
  resetEnabledFields,
  setPacketFieldConfiguration,
} from "@/lib/document-schema";

type SettingsResponse = {
  fieldSettings?: Array<{
    doc_type: string;
    field_key: string;
    enabled: boolean;
  }>;
  docTypeSettings?: Array<{ doc_type: string; enabled: boolean }>;
};

let pendingRuntimeFieldSettings: Promise<SettingsResponse> | null = null;

function fetchRuntimeFieldSettings() {
  if (pendingRuntimeFieldSettings) return pendingRuntimeFieldSettings;

  const request = apiFetch("/api/settings/field", {
    method: "GET",
    cache: "no-store",
  })
    .then(async (response) => {
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      return (await response.json()) as SettingsResponse;
    })
    .finally(() => {
      if (pendingRuntimeFieldSettings === request) {
        pendingRuntimeFieldSettings = null;
      }
    });

  pendingRuntimeFieldSettings = request;
  return request;
}

export function RuntimeFieldSettingsBootstrap() {
  useEffect(() => {
    let active = true;

    const loadRuntimeFieldSettings = async () => {
      try {
        const payload = await fetchRuntimeFieldSettings();
        if (!active) {
          return;
        }

        setPacketFieldConfiguration(
          buildPacketFieldConfiguration({
            fieldSettings: payload.fieldSettings,
            docTypeSettings: payload.docTypeSettings,
          }),
        );
      } catch {
        if (!active) {
          return;
        }
        resetEnabledFields();
      }
    };

    void loadRuntimeFieldSettings();

    return () => {
      active = false;
    };
  }, []);

  return null;
}
