## Yak pager

Core logic is runPass in pass.ts (measure + solve, through measurer adapters in measurers.ts over the unit walk in units.ts) and the decorate step in paginationPlugin.ts:
- Measure.
- Solve.
- Decorate.

The apply hook keeps track of what ranges were modified across transactions.

Then schedule runs the pass in a microtask after each transaction, before the browser paints (several transactions in one task share one pass). That is the meat of the logic.

Some interesting bits are -
- split candidates - this is where it calculates split positions of every line in a para.

Tables (`?lang=table`, or the toolbar's Insert table) paginate row by row: each row is an atomic unit, Pretext predicts its height from its cells at their column widths, and the gap between two rows is a table row. See design_decisions.md section 6, and `npm run table-spike` for the table vs CSS grid comparison.
