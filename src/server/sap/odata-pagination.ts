export type ODataCollectionBody<T> = Record<string, unknown> & {
  value?: T[];
};

type ReadODataCollectionOptions<T> = {
  initialPath: string;
  baseUrl: string;
  max: number;
  read: (path: string) => Promise<ODataCollectionBody<T>>;
};

function serviceLayerUrl(value: string, baseUrl: string): URL {
  const base = new URL(baseUrl);
  if (value.startsWith("https://") || value.startsWith("http://")) {
    return new URL(value);
  }
  if (value.startsWith(`${base.pathname}/`)) {
    return new URL(value, base.origin);
  }
  if (value.startsWith("/")) {
    return new URL(`${baseUrl}${value}`);
  }
  return new URL(value, `${baseUrl}/`);
}

function belongsToServiceLayer(url: URL, base: URL): boolean {
  return (
    url.origin === base.origin &&
    (url.pathname === base.pathname ||
      url.pathname.startsWith(`${base.pathname}/`))
  );
}

function collectionPath(
  path: string,
  baseUrl: string,
  top: number,
  skip: number,
): string {
  const url = serviceLayerUrl(path, baseUrl);
  const base = new URL(baseUrl);
  if (!belongsToServiceLayer(url, base)) {
    throw new Error("SAP returned a continuation link outside its Service Layer endpoint.");
  }
  url.searchParams.set("$top", String(top));
  url.searchParams.set("$skip", String(skip));
  const relativePath = url.pathname.slice(base.pathname.length);
  return `${relativePath.startsWith("/") ? relativePath : `/${relativePath}`}${url.search}`;
}

function continuationPath(value: unknown, baseUrl: string): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const url = serviceLayerUrl(value, baseUrl);
  const base = new URL(baseUrl);
  if (!belongsToServiceLayer(url, base)) {
    throw new Error("SAP returned a continuation link outside its Service Layer endpoint.");
  }
  const relativePath = url.pathname.slice(base.pathname.length);
  return `${relativePath.startsWith("/") ? relativePath : `/${relativePath}`}${url.search}`;
}

/**
 * Reads an OData collection using SAP's continuation link. Some SAP Service
 * Layer installations cap each response below the requested $top, so a short
 * page is not treated as the end of the collection. When an older Service
 * Layer omits the link, the next $skip is derived from the number of rows SAP
 * actually returned.
 */
export async function readODataCollection<T>(
  options: ReadODataCollectionOptions<T>,
): Promise<T[]> {
  if (!Number.isInteger(options.max) || options.max <= 0) return [];

  const pageSize = Math.min(100, options.max);
  const initialUrl = serviceLayerUrl(options.initialPath, options.baseUrl);
  const initialSkip = Number(initialUrl.searchParams.get("$skip") ?? 0);
  const baseSkip = Number.isInteger(initialSkip) && initialSkip >= 0 ? initialSkip : 0;
  const rows: T[] = [];
  const visitedPaths = new Set<string>();
  const firstRows = new Set<string>();
  let nextPath = collectionPath(
    options.initialPath,
    options.baseUrl,
    Math.min(pageSize, options.max),
    baseSkip,
  );

  while (rows.length < options.max) {
    if (visitedPaths.has(nextPath)) {
      throw new Error("SAP repeated a continuation link; the read was stopped to avoid incomplete data.");
    }
    visitedPaths.add(nextPath);

    const body = await options.read(nextPath);
    const page = Array.isArray(body.value) ? body.value : [];
    if (!page.length) break;

    const first = JSON.stringify(page[0]);
    if (firstRows.has(first)) {
      throw new Error("SAP repeated a result page; the read was stopped to avoid incomplete data.");
    }
    firstRows.add(first);
    rows.push(...page.slice(0, options.max - rows.length));
    if (rows.length >= options.max) break;

    const suppliedNext =
      continuationPath(body["@odata.nextLink"], options.baseUrl) ??
      continuationPath(body["odata.nextLink"], options.baseUrl);
    nextPath =
      suppliedNext ??
      collectionPath(
        options.initialPath,
        options.baseUrl,
        Math.min(pageSize, options.max - rows.length),
        baseSkip + rows.length,
      );
  }

  return rows;
}
