# Feature Coverage Audit

Generated: 2026-08-22T13:35:50.287Z

- Total features: 44
- Wired: 0
- Partial: 16
- Unwired: 28
- Default-ON but unwired: 16

- Must-live but unwired: 0

| Feature ID | Scope | Default | Must-live | JS refs | Status |
|---|---|---:|---:|---:|---|
| auth.otp | system | on | no | 0 | unwired |
| auth.flat_binding | system | on | no | 0 | unwired |
| auth.tenant_owner | system | on | no | 0 | unwired |
| event.templates | system | on | no | 0 | unwired |
| event.multi_cluster | system | on | no | 0 | unwired |
| event.draft_publish | event | on | no | 0 | unwired |
| event.emergency | event | off | no | 0 | unwired |
| event.milestones | event | off | no | 0 | unwired |
| event.moderator_history | event | off | yes | 1 | partial |
| contribution.voluntary | event | on | yes | 1 | partial |
| contribution.suggested | event | on | yes | 1 | partial |
| contribution.custom | event | on | yes | 1 | partial |
| contribution.fixed | event | off | no | 0 | unwired |
| contribution.per_head | event | off | no | 0 | unwired |
| privacy.anonymous | event | on | yes | 1 | partial |
| privacy.public_board | event | on | yes | 1 | partial |
| privacy.amount_hidden | event | off | no | 2 | partial |
| privacy.public_mask | system | off | no | 1 | partial |
| registration.on | event | off | no | 1 | partial |
| registration.family | event | off | no | 0 | unwired |
| registration.count | event | off | no | 0 | unwired |
| registration.food | event | off | no | 0 | unwired |
| registration.team | event | off | no | 0 | unwired |
| registration.capacity | event | off | no | 0 | unwired |
| registration.volunteer | event | off | no | 0 | unwired |
| payment.upi | system | on | yes | 2 | partial |
| payment.bank | system | on | yes | 1 | partial |
| payment.cash | system | on | no | 0 | unwired |
| payment.verify | system | on | yes | 1 | partial |
| receipt.generate | event | on | yes | 1 | partial |
| receipt.stamp | system | on | no | 0 | unwired |
| receipt.qr_verify | system | on | no | 0 | unwired |
| receipt.archive | system | on | yes | 1 | partial |
| reporting.progress | event | on | yes | 1 | partial |
| reporting.public_total | event | on | no | 0 | unwired |
| reporting.expenses | event | off | no | 0 | unwired |
| reporting.event_detail_signedin | event | off | yes | 2 | partial |
| reporting.audit_log | system | on | no | 0 | unwired |
| notify.event_created | system | on | no | 0 | unwired |
| notify.reminder | event | off | no | 0 | unwired |
| notify.receipt_ready | system | on | no | 0 | unwired |
| admin.feature_toggle | system | on | no | 0 | unwired |
| admin.template_editor | system | on | no | 0 | unwired |
| admin.users | system | on | no | 0 | unwired |
