/**
 * Independent check of the LIVE API's price series.
 *
 * Deliberately does not import src/api/price.ts: it re-derives every price from the
 * stored raw totals with its own arithmetic, so a bug shared between the module and the
 * server would still show up here. Temporary tooling, deleted after the smoke test.
 *
 * Fetches the URL itself rather than reading a saved file -- an earlier version piped
 * curl into a file and the file was gone by the time this ran.
 */
const base = process.argv[2] ?? 'http://127.0.0.1:8792';
const response = await fetch(`${base}/api/price?limit=4`);
const body = await response.json();
console.log(`HTTP ${response.status} count=${body.count} limit=${body.limit} seriesFromBlock=${body.seriesFromBlock}`);
for (const point of body.series) {
  // The brief's formula, written out longhand with no helper.
  const offset = 18 - 6;
  const raw = ((BigInt(point.totalAssets) + 1n) * 10n ** 18n) / (BigInt(point.totalSupply) + 10n ** BigInt(offset));
  const digits = raw.toString().padStart(7, '0');
  const formatted = `${digits.slice(0, digits.length - 6)}.${digits.slice(digits.length - 6)}`.replace(/0+$/, '').replace(/\.$/, '');
  console.log(
    `  block ${point.blockNumber}  assets ${point.totalAssets}  supply ${point.totalSupply}  ` +
      `served ${point.price}  independent ${formatted}  ${formatted === point.price ? 'OK' : 'MISMATCH'}`,
  );
}
