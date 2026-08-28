/** Keep committed generated source byte-identical on every supported host. */
export function canonicalGeneratedText(value) {
  return value.replace(/\r\n?/g, "\n");
}
