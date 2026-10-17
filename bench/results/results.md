# Benchmark: orchestrator vs sequential ReAct baseline

8 incidents x seeds [1, 2, 3, 4, 5], role `responder`, mock LLM, simulated tool and LLM latency on a virtual clock (exact and reproducible).

| system | top-1 | top-3 | mean time | p95 time | tool calls | LLM calls | est. tokens | policy denials |
|---|---|---|---|---|---|---|---|---|
| orchestrator | 100% | 100% | 6.4s | 8.1s | 19.27 | 3 | 4420 | 5 |
| baseline | 75% | 75% | 6.7s | 14.7s | 3.5 | 4.5 | 6683 | 0 |

## Per incident

| incident | orchestrator top-1 | baseline top-1 | orchestrator time | baseline time | baseline's answer |
|---|---|---|---|---|---|
| bad-deploy | 100% | 100% | 6.6s | 5.5s | correct |
| flag-retry-storm | 100% | 100% | 5.4s | 5.2s | correct |
| pool-exhaustion | 100% | 100% | 6.6s | 5.2s | correct |
| missing-index | 100% | 100% | 6.6s | 5.6s | correct |
| upstream-gateway | 100% | 0% | 6.8s | 5.3s | wrong: `bad_deploy:payments:dep-payments-2.4.0` |
| cert-expiry | 100% | 0% | 6.5s | 5.2s | wrong: `flag_change:api:api.new_checkout_banner` |
| memory-leak | 100% | 100% | 6.2s | 8.1s | correct |
| disk-full-injection | 100% | 100% | 6.8s | 13.5s | correct |
