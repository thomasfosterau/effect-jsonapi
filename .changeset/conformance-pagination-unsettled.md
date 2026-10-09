---
"@thomasfosterau/effect-jsonapi": patch
---

`spec/pagination/links-enumerate-collection` no longer decides a collection on evidence it did not get:

- When the rule's 200-request budget runs out before a `first` or `last` link is checked, the collection is reported not decided, naming the budget. It used to pass silently.
- When the budget runs out before the order recheck, or the recheck gets no page back, the order-dependent findings (a repeat, a gap, a `first` / `last` page that disagrees) are withheld. They used to stand as if the order had been confirmed stable.
- Order-dependent findings are now rechecked on every path out of the rule, including a walk cut short by an off-origin `next` or the budget.
- A server error, a `429` or a lost response, whether mid-walk or from a `first` / `last` link, leaves the collection not decided, as it already did for the reference request. It is no longer a MUST failure that "`next` … leads to a response that is not a page". A `next` that leads to any other 4xx, or to a 2xx that is not a page, is still a finding.
- A page whose `data` holds items, none of which has a string `type` and `id` (or `lid`), leaves the collection not decided. It used to be reported as a page that lists no resources.
