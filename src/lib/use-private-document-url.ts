"use client";

import { useEffect, useState } from "react";
import { downloadPrivateDocument } from "./file-transfer-client";

export function usePrivateDocumentUrl(source: string | null) {
  const [state, setState] = useState<{
    source: string | null;
    url: string | null;
    error: string | null;
  }>({ source: null, url: null, error: null });
  const privateFile = Boolean(
    source?.startsWith("/api/cases/") &&
    source.includes("/files?") &&
    new URL(source, "https://same-origin.invalid").searchParams.get(
      "content",
    ) === "1",
  );
  useEffect(() => {
    if (!source || !privateFile) return;
    const controller = new AbortController();
    let objectUrl: string | null = null;
    void downloadPrivateDocument(source, controller.signal)
      .then((blob) => {
        if (controller.signal.aborted) return;
        objectUrl = URL.createObjectURL(blob);
        setState({ source, url: objectUrl, error: null });
      })
      .catch((error) => {
        if (!controller.signal.aborted)
          setState({
            source,
            url: null,
            error:
              error instanceof Error
                ? error.message
                : "The document could not be loaded. Reopen it to retry.",
          });
      });
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [source, privateFile]);
  return {
    url: privateFile ? (state.source === source ? state.url : null) : source,
    error: privateFile && state.source === source ? state.error : null,
    loading:
      privateFile && (state.source !== source || (!state.url && !state.error)),
  };
}
