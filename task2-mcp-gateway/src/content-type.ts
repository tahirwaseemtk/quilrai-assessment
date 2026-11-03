// Accepts `application/json` with no parameters or a single `charset=utf-8` (quoted or not).
// Every other charset is refused rather than transcoded: the body is decoded as strict UTF-8 and
// forwarded as-is, so the bytes the gateway checks are the bytes the downstream reads.
export function isJsonContentType(values: readonly string[] | undefined): boolean {
  // More than one header is ambiguous, like a duplicated Authorization header.
  if (values?.length !== 1 || values[0] === undefined) return false;
  const [type = '', ...params] = values[0].split(';');
  if (type.trim().toLowerCase() !== 'application/json') return false;

  let charsetSeen = false;
  for (const raw of params) {
    const param = raw.trim();
    // "application/json;" has an empty parameter list, which is valid.
    if (param === '') continue;
    const separator = param.indexOf('=');
    if (separator === -1 || charsetSeen) return false;
    const name = param.slice(0, separator).trim().toLowerCase();
    let value = param.slice(separator + 1).trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    }
    if (name !== 'charset' || value.toLowerCase() !== 'utf-8') return false;
    charsetSeen = true;
  }
  return true;
}
