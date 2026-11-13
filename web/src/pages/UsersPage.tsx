import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Eye,
  KeyRound,
  Pencil,
  Plus,
  Power,
  Search,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { supabase } from "../lib/supabase";
import { useAuth } from "../lib/auth";
import { friendlyError } from "../lib/errors";
import { formatDate } from "../lib/jobs";
import { formatMoment } from "../lib/production";
import { ROLE_LABELS } from "../lib/types";
import type { Role } from "../lib/types";
import { callAdmin, grantText } from "../lib/users";
import type { Matrix, ResourceRow, UserRow } from "../lib/users";
import { ConfirmDialog, Modal } from "../components/Modal";
import { ResetPasswordDialog } from "../components/ResetPasswordDialog";
import { useToast } from "../components/Toast";

const PAGE_SIZE = 15;

interface Detail {
  matrix: Matrix;
  records: number | null;
}

// List of Users: view, edit, permissions, activate/deactivate, reset password, delete.
export function UsersPage() {
  const { can, profile: me, isSuperAdmin } = useAuth();
  const notify = useToast();
  const navigate = useNavigate();
  const [rows, setRows] = useState<UserRow[]>([]);
  const [resources, setResources] = useState<ResourceRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [query, setQuery] = useState("");
  const [role, setRole] = useState<"" | Role>("");
  const [status, setStatus] = useState<"all" | "active" | "inactive">("all");
  const [page, setPage] = useState(1);
  const [viewing, setViewing] = useState<UserRow | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [toggling, setToggling] = useState<UserRow | null>(null);
  const [resetting, setResetting] = useState<UserRow | null>(null);
  const [deleting, setDeleting] = useState<{
    user: UserRow;
    records: number | null;
  } | null>(null);
  const [busy, setBusy] = useState(false);

  const canCreate = can("users", "create");
  const canEdit = can("users", "edit");
  const canDelete = can("users", "delete");

  const load = useCallback(async () => {
    const [{ data, error }, res] = await Promise.all([
      supabase.rpc("user_directory"),
      supabase
        .from("permission_resources")
        .select("key, module, label, sort_order")
        .order("sort_order"),
    ]);
    if (error) setLoadError(friendlyError(error));
    else {
      setRows((data ?? []) as UserRow[]);
      setLoadError("");
    }
    setResources((res.data ?? []) as ResourceRow[]);
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter(
      (r) =>
        (!q ||
          r.full_name.toLowerCase().includes(q) ||
          r.username.includes(q)) &&
        (!role || r.role === role) &&
        (status === "all" || (status === "active") === r.active),
    );
  }, [rows, query, role, status]);
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const current = Math.min(page, pages);
  const visible = filtered.slice(
    (current - 1) * PAGE_SIZE,
    current * PAGE_SIZE,
  );
  const counts = {
    total: rows.length,
    active: rows.filter((r) => r.active).length,
  };

  // Super Admin row: only the Super Admin may change it, and it can't be deactivated or deleted.
  const editable = (u: UserRow) =>
    canEdit && (u.role !== "super_admin" || u.id === me?.id);
  const others = (u: UserRow) => u.role !== "super_admin" && u.id !== me?.id;

  async function openView(u: UserRow) {
    setViewing(u);
    setDetail(null);
    const [perms, refs] = await Promise.all([
      supabase
        .from("user_permissions")
        .select("resource, can_view, can_create, can_edit, can_delete")
        .eq("profile_id", u.id),
      supabase.rpc("user_record_count", { p_id: u.id }),
    ]);
    const m: Matrix = {};
    for (const p of (perms.data ?? []) as {
      resource: ResourceRow["key"];
      can_view: boolean;
      can_create: boolean;
      can_edit: boolean;
      can_delete: boolean;
    }[]) {
      m[p.resource] = {
        view: p.can_view,
        create: p.can_create,
        edit: p.can_edit,
        delete: p.can_delete,
      };
    }
    setDetail({
      matrix: m,
      records: refs.error
        ? null
        : ((refs.data as { total: number }).total ?? 0),
    });
  }

  async function askDelete(u: UserRow) {
    setDeleting({ user: u, records: null });
    const { data, error } = await supabase.rpc("user_record_count", {
      p_id: u.id,
    });
    setDeleting({
      user: u,
      records: error ? -1 : (data as { total: number }).total,
    });
  }

  async function confirmToggle() {
    if (!toggling) return;
    setBusy(true);
    try {
      await callAdmin({
        action: "set_active",
        id: toggling.id,
        active: !toggling.active,
      });
      notify(
        "success",
        `${toggling.full_name} ${toggling.active ? "deactivated: they can no longer sign in" : "activated"}.`,
      );
      await load();
    } catch (err) {
      notify("error", (err as Error).message);
    } finally {
      setBusy(false);
      setToggling(null);
    }
  }

  async function confirmDelete() {
    if (!deleting) return;
    setBusy(true);
    try {
      await callAdmin({ action: "delete", id: deleting.user.id });
      notify("success", `${deleting.user.full_name} deleted.`);
      await load();
    } catch (err) {
      notify("error", (err as Error).message);
    } finally {
      setBusy(false);
      setDeleting(null);
    }
  }

  const headers = [
    "S.No",
    "Name",
    "Username",
    "Role",
    "Status",
    "Machines",
    "Last Sign-in",
    "Created Date",
    "",
  ];

  return (
    <>
      <div className="pagehead">
        <div>
          <h1>List of Users</h1>
          <p className="muted">
            {counts.total} user{counts.total === 1 ? "" : "s"} · {counts.active}{" "}
            active
          </p>
        </div>
        {canCreate && (
          <div className="actions">
            <button
              type="button"
              className="primary"
              onClick={() => navigate("/users/new")}
            >
              <Plus size={18} /> Create User
            </button>
          </div>
        )}
      </div>

      <section className="card">
        <div className="toolbar">
          <label className="search">
            <Search size={18} aria-hidden="true" />
            <input
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setPage(1);
              }}
              placeholder="Search name or username"
              aria-label="Search"
            />
          </label>
          <select
            value={role}
            onChange={(e) => (setRole(e.target.value as "" | Role), setPage(1))}
            aria-label="Role filter"
          >
            <option value="">All roles</option>
            {(Object.keys(ROLE_LABELS) as Role[]).map((r) => (
              <option key={r} value={r}>
                {ROLE_LABELS[r]}
              </option>
            ))}
          </select>
          <select
            value={status}
            onChange={(e) => (
              setStatus(e.target.value as typeof status),
              setPage(1)
            )}
            aria-label="Status filter"
          >
            <option value="all">All statuses</option>
            <option value="active">Active</option>
            <option value="inactive">Inactive</option>
          </select>
        </div>
        {loadError && <p className="notice error">{loadError}</p>}

        <div className="tablewrap">
          <table className="users-table">
            <thead>
              <tr>
                {headers.map((h) => (
                  <th key={h}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={headers.length} className="empty">
                    Loading…
                  </td>
                </tr>
              ) : visible.length === 0 ? (
                <tr>
                  <td colSpan={headers.length} className="empty">
                    {rows.length ? "No matching users." : "No users yet."}
                  </td>
                </tr>
              ) : (
                visible.map((u, i) => (
                  <tr
                    key={u.id}
                    className={`clickable${u.active ? "" : " inactive-row"}`}
                    onClick={() => openView(u)}
                  >
                    <td>{(current - 1) * PAGE_SIZE + i + 1}</td>
                    <td>
                      <b>{u.full_name}</b>
                      {u.id === me?.id && (
                        <span className="muted small"> (you)</span>
                      )}
                    </td>
                    <td>{u.username}</td>
                    <td>{ROLE_LABELS[u.role] ?? u.role}</td>
                    <td>
                      <span className={`badge ${u.active ? "green" : "grey"}`}>
                        {u.active ? "Active" : "Inactive"}
                      </span>
                      {u.active && u.must_change_password && (
                        <div className="muted small">Temporary password</div>
                      )}
                    </td>
                    <td>
                      {u.all_machines
                        ? "All"
                        : u.machine_codes.join(", ") || "—"}
                    </td>
                    <td>
                      {u.last_sign_in_at ? (
                        <>
                          {formatMoment(u.last_sign_in_at).split(" ")[0]}
                          <div className="muted small">
                            {formatMoment(u.last_sign_in_at)
                              .split(" ")
                              .slice(1)
                              .join(" ")}
                          </div>
                        </>
                      ) : (
                        <span className="muted">Never</span>
                      )}
                    </td>
                    <td>{formatDate(u.created_at.slice(0, 10))}</td>
                    <td
                      className="row-actions"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <div className="action-grid">
                        <button
                          type="button"
                          className="icon-button"
                          title="View"
                          aria-label={`View ${u.username}`}
                          onClick={() => openView(u)}
                        >
                          <Eye size={17} />
                        </button>
                        {editable(u) && (
                          <button
                            type="button"
                            className="icon-button"
                            title="Edit"
                            aria-label={`Edit ${u.username}`}
                            onClick={() => navigate(`/users/${u.id}`)}
                          >
                            <Pencil size={17} />
                          </button>
                        )}
                        {isSuperAdmin && u.role !== "super_admin" && (
                          <button
                            type="button"
                            className="icon-button"
                            title="Manage Permissions"
                            aria-label={`Permissions of ${u.username}`}
                            onClick={() =>
                              navigate(`/users/${u.id}#permissions`)
                            }
                          >
                            <ShieldCheck size={17} />
                          </button>
                        )}
                        {canEdit && others(u) && (
                          <button
                            type="button"
                            className={`icon-button ${u.active ? "danger-text" : ""}`}
                            title={u.active ? "Deactivate" : "Activate"}
                            aria-label={`${u.active ? "Deactivate" : "Activate"} ${u.username}`}
                            onClick={() => setToggling(u)}
                          >
                            <Power size={17} />
                          </button>
                        )}
                        {canEdit && others(u) && (
                          <button
                            type="button"
                            className="icon-button"
                            title="Reset Password"
                            aria-label={`Reset password of ${u.username}`}
                            onClick={() => setResetting(u)}
                          >
                            <KeyRound size={17} />
                          </button>
                        )}
                        {canDelete && others(u) && (
                          <button
                            type="button"
                            className="icon-button danger-text"
                            title="Delete"
                            aria-label={`Delete ${u.username}`}
                            onClick={() => askDelete(u)}
                          >
                            <Trash2 size={17} />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        <div className="pager">
          <span className="muted small">
            {filtered.length
              ? `Showing ${(current - 1) * PAGE_SIZE + 1}–${Math.min(current * PAGE_SIZE, filtered.length)} of ${filtered.length}`
              : "Showing 0 users"}
          </span>
          <div className="actions">
            <button
              type="button"
              disabled={current <= 1}
              onClick={() => setPage(current - 1)}
            >
              Previous
            </button>
            <button
              type="button"
              disabled={current >= pages}
              onClick={() => setPage(current + 1)}
            >
              Next
            </button>
          </div>
        </div>
      </section>

      {viewing && (
        <Modal
          title={`${viewing.full_name} · ${viewing.username}`}
          onClose={() => setViewing(null)}
          width={720}
          footer={
            <>
              <button type="button" onClick={() => setViewing(null)}>
                Close
              </button>
              {editable(viewing) && (
                <button
                  type="button"
                  className="primary"
                  onClick={() => navigate(`/users/${viewing.id}`)}
                >
                  <Pencil size={16} /> Edit
                </button>
              )}
            </>
          }
        >
          <dl className="summary-list wide">
            <dt>Role</dt>
            <dd>{ROLE_LABELS[viewing.role] ?? viewing.role}</dd>
            <dt>Status</dt>
            <dd>
              {viewing.active ? "Active" : "Inactive (cannot sign in)"}
              {viewing.must_change_password && viewing.active
                ? " · temporary password not yet changed"
                : ""}
            </dd>
            <dt>Machines</dt>
            <dd>
              {viewing.role === "super_admin" || viewing.all_machines
                ? "All machines"
                : viewing.machine_codes.join(", ") || "None"}
            </dd>
            <dt>Last sign-in</dt>
            <dd>
              {viewing.last_sign_in_at
                ? formatMoment(viewing.last_sign_in_at)
                : "Never"}
            </dd>
            <dt>Created</dt>
            <dd>{formatMoment(viewing.created_at)}</dd>
            <dt>Records in the logbook</dt>
            <dd>{detail ? (detail.records ?? "—") : "Loading…"}</dd>
          </dl>
          <h3>Permissions</h3>
          {viewing.role === "super_admin" ? (
            <p>Every permission (Super Admin).</p>
          ) : !detail ? (
            <p className="muted">Loading…</p>
          ) : (
            <div className="tablewrap">
              <table className="compact">
                <thead>
                  <tr>
                    <th>Module</th>
                    <th>Screen</th>
                    <th>Allowed</th>
                  </tr>
                </thead>
                <tbody>
                  {resources.map((r) => (
                    <tr
                      key={r.key}
                      className={detail.matrix[r.key]?.view ? "" : "muted"}
                    >
                      <td>{r.module}</td>
                      <td>{r.label}</td>
                      <td>{grantText(detail.matrix[r.key])}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Modal>
      )}

      {toggling && (
        <ConfirmDialog
          title={`${toggling.active ? "Deactivate" : "Activate"} ${toggling.full_name}?`}
          message={
            toggling.active
              ? "They are signed out and cannot sign in until the account is activated again. Their records stay as they are."
              : "They can sign in again with their current password and permissions."
          }
          confirmLabel={toggling.active ? "Deactivate" : "Activate"}
          danger={toggling.active}
          busy={busy}
          onConfirm={confirmToggle}
          onCancel={() => setToggling(null)}
        />
      )}

      {resetting && (
        <ResetPasswordDialog
          user={resetting}
          onClose={() => setResetting(null)}
          onDone={(message) => {
            setResetting(null);
            notify("success", message);
            load();
          }}
        />
      )}

      {deleting &&
        (deleting.records === null ? (
          <Modal
            title={`Delete ${deleting.user.full_name}?`}
            onClose={() => setDeleting(null)}
            width={440}
          >
            <p className="muted">Checking the user's records…</p>
          </Modal>
        ) : deleting.records !== 0 ? (
          <Modal
            title={`${deleting.user.full_name} cannot be deleted`}
            onClose={() => setDeleting(null)}
            width={480}
            footer={
              <>
                <button type="button" onClick={() => setDeleting(null)}>
                  Close
                </button>
                {deleting.user.active && canEdit && (
                  <button
                    type="button"
                    className="danger"
                    onClick={() => {
                      setToggling(deleting.user);
                      setDeleting(null);
                    }}
                  >
                    <Power size={16} /> Deactivate instead
                  </button>
                )}
              </>
            }
          >
            <p>
              {deleting.records > 0
                ? `This user has ${deleting.records} record(s) in the logbook (entries, plans or changes). To keep the history complete, deactivate the account instead: they cannot sign in, and their name stays on their records.`
                : "Could not check this user’s records. Please try again."}
            </p>
          </Modal>
        ) : (
          <ConfirmDialog
            title={`Delete ${deleting.user.full_name}?`}
            message={`The account ${deleting.user.username} has no records and will be removed permanently, with its permissions and machine access. This cannot be undone.`}
            confirmLabel="Delete"
            danger
            busy={busy}
            onConfirm={confirmDelete}
            onCancel={() => setDeleting(null)}
          />
        ))}
    </>
  );
}
