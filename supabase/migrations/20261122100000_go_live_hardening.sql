-- Go-live hardening (Supabase Security Advisor).
--
-- These functions are only used inside other database functions (which run with
-- their owner's rights) or as a trigger, so signed-in users never need to call
-- them directly. Removing the direct call right closes a way to read across
-- machines and orders without the screen permissions.
--
-- The remaining "signed-in users can execute SECURITY DEFINER function" warnings
-- are the app's own actions (save entry, save job, users, ...): each one checks
-- the caller's permissions itself, and permission helpers (has_perm,
-- can_use_machine, is_active_user, is_super_admin) are needed by the row-level
-- security rules.

revoke execute on function
  public.audit_row(),
  public.downtime_clash(uuid, timestamptz, timestamptz, uuid, uuid),
  public.is_first_order_entry(text, uuid),
  public.machine_ready_after(uuid, timestamptz, timestamptz),
  public.order_fully_closed(text),
  public.can_set_shift_end()
from public, anon, authenticated;
