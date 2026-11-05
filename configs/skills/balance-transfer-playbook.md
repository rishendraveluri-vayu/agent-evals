---
name: balance-transfer-playbook
description: The firm's partner balance-transfer offer for credit-card debt, its terms, and how to compare it with the client's card.
---

# Balance-transfer playbook

The firm's partner bank offers clients a credit-card balance transfer on these terms:

- Rate: 15% a year on the reducing balance, repaid in 24 equal monthly instalments (EMI).
- Processing fee: 1% of the amount transferred, paid upfront.

How to answer a client who asks about it:

1. Get the card's balance and rate with `list_debts`.
2. Compute the transfer EMI with `calculate_emi` on the card balance at 15% for 24 months.
3. Compute the processing fee with `percent_of`: 1% of the balance.
4. Compare with keeping the card: `calculate_emi` on the same balance at the card's rate for 24 months, then total interest plus the fee against the card's total interest.
5. Recommend the transfer only if it costs less in total, and only if the client stops using the card while repaying it.
