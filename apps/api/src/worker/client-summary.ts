/**
 * D27: a short summary of a task's client file (the finance MCP server's client.json), for the
 * simulated client's prompt. It holds the profile, as recorded, the debts with their totals, and
 * (D30) every transaction of the latest month in the file with that month's totals, which is what
 * get_client_profile, list_debts and list_transactions show the agent, so the simulator knows
 * what the advisor can read and never contradicts it.
 *
 * Money in the debts is written as the tools write it (₹ with Indian digit grouping and paise);
 * profile values are written as recorded, since the profile is free-form.
 */

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** `92500` to `₹92,500.00`, `441050` to `₹4,41,050.00`, as finance_mcp.money.format_inr does. */
export function formatInr(amount: number): string {
  const paise = Math.round(Math.abs(amount) * 100);
  const whole = String(Math.floor(paise / 100));
  const frac = String(paise % 100).padStart(2, '0');
  const grouped = whole.length > 3 ? `${whole.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${whole.slice(-3)}` : whole;
  return `${amount < 0 && paise > 0 ? '-' : ''}₹${grouped}.${frac}`;
}

const words = (key: string): string => key.replace(/_/g, ' ');

function plain(v: unknown): string {
  if (v === null || v === undefined) return 'not recorded';
  if (Array.isArray(v)) return v.length ? v.map(plain).join('; ') : 'none';
  if (isObj(v)) return Object.entries(v).map(([k, x]) => `${words(k)} ${plain(x)}`).join(', ');
  return typeof v === 'string' ? v : JSON.stringify(v);
}

function debtLine(d: Obj): string {
  const about = [d.kind, d.lender].filter((x): x is string => typeof x === 'string' && x !== '').map(words);
  const parts: string[] = [];
  const balance = num(d.balance);
  const rate = num(d.annual_rate_pct);
  const minimum = num(d.minimum_payment);
  const months = num(d.remaining_months);
  if (balance !== null) parts.push(`balance ${formatInr(balance)}${rate !== null ? ` at ${rate}% a year` : ''}`);
  else if (rate !== null) parts.push(`${rate}% a year`);
  if (minimum !== null) parts.push(`minimum payment ${formatInr(minimum)} a month`);
  if (months !== null) parts.push(`${months} months left`);
  const name = typeof d.name === 'string' && d.name ? d.name : 'Debt';
  return `- ${name}${about.length ? ` (${about.join(', ')})` : ''}: ${parts.join(', ') || 'no figures recorded'}`;
}

/** The summary, or null when there is no client file or it is not a client.json with a profile. */
export function clientSummary(state: Buffer | string | null | undefined): string | null {
  if (state === null || state === undefined) return null;
  let data: unknown;
  try {
    data = JSON.parse(typeof state === 'string' ? state : state.toString('utf8'));
  } catch {
    return null;
  }
  if (!isObj(data) || !isObj(data.profile)) return null;
  const lines = ['Profile:', ...Object.entries(data.profile).map(([k, v]) => `- ${words(k)}: ${plain(v)}`)];
  const debts = Array.isArray(data.debts) ? data.debts.filter(isObj) : [];
  if (debts.length) {
    const sum = (field: string): number => debts.reduce((total, d) => total + Math.round((num(d[field]) ?? 0) * 100), 0) / 100;
    lines.push(`Debts (${debts.length}, total balance ${formatInr(sum('balance'))}, total minimum payments ${formatInr(sum('minimum_payment'))} a month):`);
    lines.push(...debts.map(debtLine));
  } else {
    lines.push('Debts: none recorded');
  }
  lines.push(...transactionLines(data.transactions));
  return lines.join('\n');
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** D30: the latest month's transactions, oldest first, with money in and out for that month. */
function transactionLines(raw: unknown): string[] {
  const rows = (Array.isArray(raw) ? raw.filter(isObj) : []).filter(
    (r) => typeof r.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(r.date) && num(r.amount) !== null,
  );
  if (!rows.length) return ['Transactions: none recorded'];
  const month = rows.map((r) => (r.date as string).slice(0, 7)).sort().at(-1)!;
  const inMonth = rows.filter((r) => (r.date as string).startsWith(month)).sort((a, b) => (a.date as string).localeCompare(b.date as string));
  const cents = (r: Obj): number => Math.round((num(r.amount) ?? 0) * 100);
  const credit = (r: Obj): boolean => r.direction === 'credit';
  const moneyIn = inMonth.filter(credit).reduce((s, r) => s + cents(r), 0) / 100;
  const moneyOut = inMonth.filter((r) => !credit(r)).reduce((s, r) => s + cents(r), 0) / 100;
  const [year, mm] = month.split('-');
  const name = `${MONTHS[Number(mm) - 1]} ${year}`;
  return [
    `Transactions in ${name} (${inMonth.length}; money in ${formatInr(moneyIn)}, money out ${formatInr(moneyOut)}):`,
    ...inMonth.map((r) => {
      const day = Number((r.date as string).slice(8, 10));
      const what = typeof r.description === 'string' && r.description ? r.description : typeof r.category === 'string' ? words(r.category) : 'transaction';
      return `- ${day} ${MONTHS[Number(mm) - 1].slice(0, 3)}: ${what}, ${credit(r) ? 'in' : 'out'} ${formatInr(num(r.amount)!)}`;
    }),
  ];
}
