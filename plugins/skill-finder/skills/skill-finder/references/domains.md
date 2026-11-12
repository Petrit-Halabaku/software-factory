# Domains, tasks and conflicts

Load this when the task's domain is unclear, when it spans several domains, or when fewer than two installed candidates fit. The keyword lists that tag skills and queries live in `scripts/inventory.mjs` (`DOMAINS`, `TASKS`); extend them there, not here, so the script and this file cannot drift.

## Split the task before matching

A request that spans domains gets one candidate per part, not one skill stretched over all of it.

| Request | Parts |
|---|---|
| "Add a pricing page with Stripe checkout and ship it" | UI (the page) · payments (checkout) · deploy (ship) |
| "Why does the login test only fail in CI?" | debugging (cause) · testing (the test) · deploy-infra (the CI environment) |
| "Turn these meeting notes into a deck for Monday" | writing (structure the content) · documents (the deck file) |
| "Make the onboarding feel smoother" | design-ui (flow and states) · motion (transitions) |

When several skills apply, order them as the work goes: a process skill that decides *how* (brainstorming, planning, debugging) comes before the implementation skill that does the work, and a verification skill comes last.

## Domains

The skill names in the last column are examples of the shape to look for, from widely used public plugins. They are not a claim that any of them is installed: check the inventory and the session's listing.

| Domain | The user wants to… | Signals in the request | Look for skills that… (examples) |
|---|---|---|---|
| design-ui | build or polish screens, layouts, themes, components, accessibility | page, screen, layout, dark mode, toggle, polish, a11y | critique or build interfaces against a design system (`frontend-design:frontend-design`) |
| motion | add or fix animation and transitions | animate, transition, spring, easing, jank | design, review or optimise motion |
| frontend | work in a web framework | React, Next.js, Vue, hydration, bundler | carry framework rules (`vercel:nextjs`, `vercel:react-best-practices`) |
| code-quality | review, simplify, refactor | review, refactor, clean up, simplify | review a diff or branch (`code-review`, `simplify`) |
| debugging | find why something fails | fails, error, crash, flaky, regression | root-cause before fixing (`superpowers:systematic-debugging`) |
| testing | write or run tests, prove a change works | test, TDD, coverage, e2e, verify | drive test-first work or verification (`superpowers:test-driven-development`, `superpowers:verification-before-completion`) |
| planning | decide what to build and how | plan, spec, design doc, brainstorm, architecture | turn an idea into a spec or plan (`superpowers:brainstorming`, `superpowers:writing-plans`) |
| security | find or fix vulnerabilities, auth and data exposure | security, auth, permissions, secrets, RLS | review changes for vulnerabilities (`security-review`) |
| data | schemas, migrations, queries | database, SQL, migration, schema | work with a specific database or ORM |
| deploy-infra | deploy, configure environments, CI, caching | deploy, env vars, CI, domain, cache | drive a hosting platform's CLI or API (`vercel:deploy`, `vercel:env`) |
| payments | checkout, billing, subscriptions | Stripe, checkout, billing, invoice | follow a payment provider's integration rules |
| design-tools | read or write design files | Figma, mockup, design tokens | bridge design files and code (`figma:figma-design-to-code`) |
| documents | produce or edit office files | PDF, Word, Excel, PowerPoint, deck | create, convert or fill a file format (`pdf`, `docx`, `xlsx`, `pptx`) |
| writing | research, summarise, draft text or prompts | research, summarise, README, changelog, prompt | research or write in a structured way |
| ai-apps | build on an LLM API or agent SDK | LLM, agent, Claude API, MCP, RAG | carry an SDK's current models and parameters (`claude-api`) |
| claude-code | configure the agent itself | settings, hooks, permissions, plugins, skills | edit settings or author skills (`update-config`, `superpowers:writing-skills`) |
| media | videos, screenshots, images | video, demo, launch, screenshot | render or capture media |
| integrations | email, calendar, trackers, chat | Gmail, Jira, Slack, Notion, webhook | drive one service through its MCP server or API |

## Tasks

The verb matters as much as the domain: it decides which skill of a domain fits and what the user expects back.

| Task | The user expects | Prefer |
|---|---|---|
| review | findings, not edits | review and audit skills; editing skills only if they asked for fixes |
| fix | the cause, then a fix | a debugging skill before any implementation skill |
| create | a working result | a planning skill first when the change is large or vague |
| change | the same behaviour, better or moved | refactor, migrate or upgrade skills; verification after |
| verify | evidence it works | verification and testing skills |
| plan | a decision or a document | brainstorming and planning skills, no implementation |
| explain | understanding | explainers, codebase tours; nothing that edits |
| operate | something deployed, configured or installed | platform CLI skills; check credentials first |
| write | a document | writing and document-format skills |

## Constraints that rule a skill out

When a constraint and a skill collide, the skill goes in "Not loading" with the reason in a few words.

| Constraint (said or shown) | Hold back |
|---|---|
| "keep the current look", "don't redesign", a design system to follow | skills that propose a new visual direction |
| no test runner, or a content-only change | skills that make test-first mandatory for every step |
| "don't commit", "don't push", or a no-commit rule in the project's instructions | skills whose steps commit, push or open pull requests |
| read-only review, audit or explanation | skills that edit files as part of their method |
| no new dependencies | skills whose first step installs packages |
| no subagents, or the user hasn't asked for parallel agents | skills that dispatch subagents or workflows |
| no network or account access | skills that drive a hosted service or registry |
| production data or a shared environment | skills that start servers, seed data or run migrations |
| two skills doing the same job | the weaker fit, or the one with more setup |
