# Bachat Security Review

Last updated: 2026-05-26

## Scope

- Admin APIs for notifications, delivery ops, city ops, finance-adjacent payout views, and seller operations.
- Notification targeting and campaign tracking.
- Delivery assignment, failed delivery handling, and driver availability.
- Payment and payout surface areas touched by buyer, seller, and admin pages.

## Controls Verified

- Admin APIs under `/api/admin/*` require authenticated admin role middleware before protected handlers run.
- Delivery partner APIs require delivery role, with KYC verification for job pool, claim, status, and GPS updates.
- Delivery availability can be updated only by the authenticated delivery partner for their own account.
- Delivery assignment from admin checks that the assigned user exists, has role `delivery`, and has verified delivery KYC.
- Delivery status changes create an audit trail through `DeliveryAudit`.
- Failed and cancelled delivery statuses store a reason for operations review.
- Notification campaign dispatch creates per-recipient `NotificationDelivery` records for audit and analytics.
- Notification click tracking only redirects to relative local paths, preventing external open redirects.
- Notification delivery tracking uses opaque delivery IDs and records open/click metadata without exposing user secrets.
- Deployment readiness check creates/verifies indexes for new operational models and reports missing required environment variables without printing secret values.

## Production Checklist

- Keep `JWT_SECRET`, SMTP credentials, Razorpay keys, and webhook secrets set only in environment/secret manager.
- Run `npm run check:deployment` before production rollout after model changes.
- Set `PUBLIC_BASE_URL` or `APP_BASE_URL` so notification tracking links point at the deployed domain.
- Keep team/admin MFA enabled in production for admin and sales roles.
- Monitor `NotificationDelivery` errors to catch failed email/WhatsApp/SMS provider jobs.
- Review admin finance and payout exports regularly for least-privilege exposure.
- Rate-limit public auth, payment, notification tracking, and delivery GPS endpoints at the reverse proxy or API gateway.
- Add provider-specific signature validation before enabling inbound WhatsApp/SMS delivery receipts.
