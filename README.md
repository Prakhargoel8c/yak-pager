## Yak pager

Core logic is in runPass in paginationPlugin.ts. It has 3 phases:
- Measure.
- Solve.
- Decorate.

The apply hook keeps track of what ranges were modified across transactions.

Then schedule runs runPass in a microtask after each transaction, before the browser paints (several transactions in one task share one pass). That is the meat of the logic.

Some interesting bits are -
- split candidates - this is where it calculates split positions of every line in a para.
