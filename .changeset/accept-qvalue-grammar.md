---
"@thomasfosterau/effect-jsonapi": patch
---

`Accept` weights are now read with the RFC 9110 §12.4.2 `qvalue` grammar (`0` to `1`, at most three decimals) instead of `Number()`. A `q` outside it — `q=`, `q=0x0`, `q=-1`, `q=1e-9`, `q=2`, `q=1.0001`, a quoted `q="0.5"` — is now malformed, handled the way `q=abc` already was in `Negotiation`: it reads as the default weight `1` (so `q=` is no longer an explicit `q=0` refusal, and `q=2` no longer outranks every other range). `Middleware` reads a malformed weight the same way (see the `Accept` malformed-weight entry, #245). Well-formed weights, including `q=0`, `q=0.000` and `Q=0`, are unchanged.
