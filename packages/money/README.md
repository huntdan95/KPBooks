# @kpbooks/money

Money arithmetic for KPBooks. Wraps `decimal.js` with a `NUMERIC(19,4)` scale and banker rounding.

**Rule:** never use raw `number` for monetary amounts. Always go through `Money`. The CI lint rule rejects `number` types on fields named `amount`, `total`, `gross`, `net`, `debit`, `credit`, etc.

## Quick reference

```ts
import { Money, isBalanced } from '@kpbooks/money';

const a = Money.of('100.00', 'USD');
const b = Money.of('33.33', 'USD');
const sum = a.add(b); // 133.3300 USD

isBalanced([Money.of('150', 'USD')], [Money.of('100', 'USD'), Money.of('50', 'USD')]); // true

Money.of('1.23', 'USD').toMinorUnits(2); // "123" — for ACH/NACHA
Money.of('1.5', 'USD').toPgNumeric(); // "1.5000" — bind directly to Postgres NUMERIC
```
