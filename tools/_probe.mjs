import { formatUnits } from '../src/api/price.ts';
const A = 934924100n, S = 849930996648200851546n;
console.log(formatUnits((A + 1n) * 10n ** 18n * 10n ** 6n / (S + 10n ** 12n), 12));
console.log(formatUnits((A + 1n) * 10n ** 18n * 10n ** 9n / (S + 10n ** 12n), 15));
