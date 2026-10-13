# Working rules for this repo

## Keep the docs current: always

Every change to this project updates the docs **in the same commit** as the code. Never
"docs later". Two files, two jobs:

- **`README.md`** says how to run and use it. Update it when a change touches:
  endpoints or request/response shapes, environment variables, scripts, setup or test
  steps, the data model, dependencies, or a limitation a user would hit.
- **`docs/DESIGN.md`** says why it is built this way. Update it when a change:
  - makes a design decision: add an entry with the decision, the alternative rejected,
    and the reason (follow the existing format);
  - changes or reverses an earlier decision: edit that entry, don't leave the old reason;
  - adds a gap or weakness: add it to "Weaknesses and known gaps";
  - fixes a listed weakness: remove it from that list and renumber;
  - moves the project forward: update "Where the project stands".

Rules for writing them:

1. **Check against the code, not memory.** Grep the real constants, route names,
   constraint names and file paths before writing them down. (A first draft of DESIGN.md
   got three claims wrong from memory.)
2. **Remove what is no longer true.** Deleting a feature means deleting its docs.
3. **Be honest about weaknesses.** Don't soften a gap to make a change look finished.
4. **Say what you did.** End the work summary with which docs were updated, or one line
   explaining why none needed to be (for example, a pure refactor).
5. Run `npx prettier --write` on any doc you touched (`npm run format:check` covers
   `docs/` and `README.md`).
