-- Reference copy of the schema Drizzle generates from
-- src/infrastructure/db/schema.ts, kept here for readability and for anyone
-- who wants to inspect or hand-apply the shape without running drizzle-kit.
-- The actual migrations Drizzle applies live in ./drizzle/*.sql -
-- `npm run db:generate` is what keeps this schema authoritative; this file
-- is documentation, not the thing that runs.

create schema if not exists crm;
create extension if not exists pgcrypto; -- for gen_random_uuid()

create table if not exists crm.raw_meta_events (
    id                 uuid primary key default gen_random_uuid(),
    object_type        text not null,
    raw_payload        jsonb not null,
    signature_header   text,
    meta_lead_id       text,
    page_id            text,
    form_id            text,
    status             text not null default 'received',
    enqueued_at        timestamptz,
    enqueue_error      text,
    qstash_message_id  text,
    received_at        timestamptz not null default now(),
    lead_id            uuid
);

create index if not exists ix_raw_meta_events_meta_lead_id on crm.raw_meta_events (meta_lead_id);
create index if not exists ix_raw_meta_events_status_received_at on crm.raw_meta_events (status, received_at);

create table if not exists crm.leads (
    id                            uuid primary key default gen_random_uuid(),
    meta_lead_id                  text not null,
    platform                      text not null,
    page_id                       text not null,
    form_id                       text not null,
    form_name                     text,
    ad_id                         text,
    ad_name                       text,
    ad_set_id                     text,
    ad_set_name                   text,
    campaign_id                   text,
    campaign_name                 text,
    full_name                     text,
    email                         text,
    phone_number                  text,
    form_responses                jsonb not null default '[]'::jsonb,
    meta_created_at               timestamptz not null,
    status                        text not null default 'pending',
    retry_count                   integer not null default 0,
    last_error                    text,
    processed_at                  timestamptz,
    recovered_by_reconciliation   boolean not null default false,
    raw_event_id                  uuid not null,
    created_at                    timestamptz not null default now(),
    updated_at                    timestamptz
);

-- THE idempotency backstop: no two rows can ever share a Meta Lead ID.
create unique index if not exists ux_leads_meta_lead_id on crm.leads (meta_lead_id);
create index if not exists ix_leads_status on crm.leads (status);
create index if not exists ix_leads_form_id on crm.leads (form_id);
create index if not exists ix_leads_campaign_id on crm.leads (campaign_id);
create index if not exists ix_leads_created_at on crm.leads (created_at);

create table if not exists crm.lead_processing_log (
    id            bigserial primary key,
    lead_id       uuid,
    raw_event_id  uuid,
    event_type    text not null,
    detail        text,
    occurred_at   timestamptz not null default now()
);

create index if not exists ix_lead_processing_log_lead_id on crm.lead_processing_log (lead_id);
create index if not exists ix_lead_processing_log_occurred_at on crm.lead_processing_log (occurred_at);

create table if not exists crm.reconciliation_runs (
    id                        bigserial primary key,
    started_at                timestamptz not null default now(),
    completed_at              timestamptz,
    forms_scanned             integer not null default 0,
    meta_leads_seen           integer not null default 0,
    missing_leads_found       integer not null default 0,
    missing_leads_recovered   integer not null default 0,
    errors                    integer not null default 0,
    notes                     text
);
