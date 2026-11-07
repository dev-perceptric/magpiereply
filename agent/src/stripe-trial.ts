// The trial's Stripe test data. Run with: npm run stripe -- <command>
//   seed     create the 8 test customers and their charges (replacing earlier ones), then check them
//   check    read them back: one customer each, every charge paid, on the right day, nothing refunded
//   remove   delete them, and their test clocks
// Needs STRIPE_SECRET_KEY, a test-mode key (sk_test_ or rk_test_).
import { loadStripeCustomers } from './evals/cases.js';
import { checkCustomer, createStripeApi, datesWarning, removeCustomer, seedCustomer, type CustomerCheck } from './evals/stripe-seed.js';

const fixtures = loadStripeCustomers();

function report(checks: CustomerCheck[]): boolean {
  for (const check of checks) console.log(`${check.fixture}: ${check.problems.length ? check.problems.join('; ') : 'ok'}`);
  const warning = datesWarning(checks);
  if (warning) console.log(warning);
  return checks.every(check => check.problems.length === 0);
}

async function main(): Promise<void> {
  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) throw new Error('STRIPE_SECRET_KEY is not set');
  const api = createStripeApi({ secretKey });
  const command = process.argv[2];

  if (command === 'seed') {
    const now = Math.floor(Date.now() / 1000);
    for (const fixture of fixtures) {
      const seeded = await seedCustomer(api, fixture, now);
      console.log(`seeded ${fixture.id}: ${seeded.customerId}, ${seeded.paymentIntents.length} charges`);
    }
  } else if (command === 'remove') {
    for (const fixture of fixtures) console.log(`${fixture.id}: removed ${await removeCustomer(api, fixture)}`);
    return;
  } else if (command !== 'check') {
    throw new Error('Usage: npm run stripe -- seed | check | remove');
  }

  const checks = [];
  for (const fixture of fixtures) checks.push(await checkCustomer(api, fixture));
  if (!report(checks)) process.exitCode = 1;
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
