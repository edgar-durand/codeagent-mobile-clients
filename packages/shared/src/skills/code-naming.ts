import type { SkillDefinition } from './types';

// Naming guidance distilled from CodeAesthetic — "Naming Things in Code"
// (https://www.youtube.com/watch?v=-J3wNP6u5YU). The video's five rules are the
// spine (no abbreviations, no type-in-variable, units when they matter, no
// type-in-type, refactor the "Utils" bucket); the rest are consistent, widely
// held extensions. Deliberately framed as a REVIEW/REFACTOR guide with strong
// "don't mass-rename" guardrails — the skill makes better names available, it
// does NOT license renaming code that was already clear.

const CODE_NAMING_BODY = `Use this skill when NAMING or RENAMING code — variables, functions, classes,
interfaces, types, files, modules, components, hooks, constants — while writing
new code, refactoring, or reviewing a diff. A name should reveal intent and
domain meaning so a reader understands the code without translating it in their
head, and so it needs fewer comments.

## The five core rules (name the concept, not the implementation)

1. **Don't abbreviate, and don't use single letters for meaningful values.**
   \`usr\`/\`cfg\`/\`authReq\` → \`user\`/\`config\`/\`authRequest\`; \`u\`/\`p\` → \`user\`/\`project\`.
   Abbreviations rely on context the next reader may not have. Allowed: standard
   acronyms the domain already uses (API, URL, HTTP, ID, UUID, CLI, SDK, PR, OAuth),
   loop indices \`i\`/\`j\`, coordinates \`x\`/\`y\`, and generic type params \`T\`/\`K\`/\`V\`.

2. **Don't put the data TYPE in a variable name.** \`userList\` → \`users\`,
   \`nameString\` → \`displayName\`, \`isActiveBool\` → \`isActive\`, \`invoiceMap\` →
   \`invoicesById\`. The type system and editor already show the type; the name
   should carry the meaning.

3. **Include the UNIT when a number has one** (unless the type makes it
   unmistakable). \`timeout\` → \`timeoutMs\`, \`delay\` → \`retryDelaySeconds\`,
   \`size\` → \`fileSizeBytes\`, \`price\` → \`priceUsd\`. Especially time, distance,
   money, bytes, rates, percentages, token/rate limits.

4. **Don't put the type CONSTRUCT in a type's name.** \`UserClass\` → \`User\`,
   \`PaymentInterface\`/\`IPayment\` → \`Payment\` (or a role like \`PaymentGateway\`),
   \`ConfigType\` → \`Config\`, \`StatusEnum\` → \`Status\`. Name the concept, not
   "what kind of programming thing it is."

5. **Refactor when you're reaching for \`Utils\`/\`Helpers\`/\`Common\`.** A generic
   bucket usually hides a missing concept. Group by domain instead:
   \`utils/parseCookie\` → a \`cookies/\` module or a \`CookieStore\`/\`CookieJar\` class;
   \`utils/formatDate\` → \`dates/\` or a \`DateRangeFormatter\`. Same for vague
   \`Base\`/\`Abstract\`/\`Manager\`/\`Helper\` class names — prefer the role
   (\`Repository\`, \`BillingService\`, \`UserProvisioner\`) unless the project
   convention explicitly requires \`Base\`/\`Abstract\`.

## Shape rules

- **Functions are verbs / verb phrases:** \`createInvoice()\`, \`sendPasswordResetEmail()\`,
  \`findRepositoryById()\`. Booleans read like a question in an \`if\`:
  \`isActive\`, \`hasAccess\`, \`canDeploy\`, \`shouldRetry\` (prefix \`is/has/can/should/needs\`).
- **Classes / interfaces / types are nouns or roles:** \`Invoice\`, \`PaymentGateway\`,
  \`AgentSession\` — not \`InvoiceData\`, \`SubscriptionThing\`, \`AgentSessionType\`.
- **Collections are plural, or \`…ById\`/\`…ByX\` when indexed:** \`users\`,
  \`activeSessions\`, \`invoicesByCustomerId\`.
- **Don't encode a temporary implementation in a name that may change:**
  \`postgresUserRepository\` → \`userRepository\`, \`redisCache\` → \`cache\` — unless the
  implementation IS the meaningful distinction. Name the role, not today's backend.
- **Follow the project's existing conventions** (casing, file naming, \`useX\`
  hooks, \`handleX\` handlers). Match the surrounding code; don't introduce a new
  style without a strong reason.

## Words to distrust (infer the real role, then name it)

\`data\`, \`info\`, \`item\`, \`obj\`, \`temp\`, \`result\`, \`value\`, \`thing\`, \`stuff\`,
\`manager\`, \`helper\`, \`utils\`, \`common\`, \`base\`, \`abstract\`, \`processor\`,
\`handler\`, \`payload\`. They're acceptable only when the surrounding context makes
them precise (e.g. \`config\` inside one \`DatabaseConnection\`); vague when passed
across many layers.

## Guardrails — this is a review/refactor guide, NOT a mass-rename mandate

- Names that are already clear and idiomatic are DONE — leave them.
- Before renaming: read how the identifier is used and infer the real domain
  concept. Prefer the **smallest** clear rename.
- Do NOT do large unrelated renames, and do NOT rename purely for personal
  preference. Stay inside the change you were asked to make.
- Preserve public API / exported names unless the task explicitly allows a break;
  when you do rename, update every reference, tests, and docs in the same change.
- No clever names, jokes, or metaphors in production code; don't make names
  needlessly long either.

When reviewing, raise a naming issue only when a clearer name would materially
help a reader — one suggestion per finding: \`current → suggested — why\`.`;

const CODE_NAMING_INSTRUCTION = `When naming or renaming code, name the domain concept, not the implementation:
no abbreviations or single-letter names for meaningful values (standard acronyms
like API/URL/ID/OAuth are fine); don't put the data type in a variable name
(userList → users); include the unit when a number has one (timeout → timeoutMs);
don't put the type construct in a type's name (IPayment → Payment); and refactor
generic Utils/Helper/Manager/Base buckets into a domain module or a role-named
class. Functions are verbs (createInvoice), booleans read like questions
(isActive/hasAccess), classes/types are nouns/roles, collections are plural or
…ById. This is a review/refactor guide, not a mandate to mass-rename: leave
already-clear names alone, prefer the smallest clear rename, don't rename
unrelated code, and preserve public/exported names unless the task allows a break.`;

export const codeNamingSkill: SkillDefinition = {
  id: 'code-naming',
  name: 'Code Naming',
  description: `Naming review & refactor: name the domain concept, not the implementation — no abbreviations, no type-in-name, units when they matter, no Utils/Manager/Base buckets; rename minimally, never mass-rename.`,
  source: 'curated',
  delivery: {
    skillFile: { body: CODE_NAMING_BODY },
    instruction: { body: CODE_NAMING_INSTRUCTION },
  },
};
