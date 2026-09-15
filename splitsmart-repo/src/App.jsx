import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import {
  Plus, Users, Wallet, Check, Lock, Zap, Trash2, Pencil, Copy,
  Download, Share2, ChevronDown, X, PartyPopper, AlertCircle,
  History, ArrowRight, Search, Filter as FilterIcon, ReceiptText,
  UserPlus, IndianRupee, ChevronLeft, Sparkles
} from "lucide-react";

/* =========================================================================
   CALCULATION ENGINE
   Pure functions, independent of the UI, operating on integer paise.
   ========================================================================= */

const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

/* Local-storage backed shim matching the window.storage API this app was
   originally built against, so it runs standalone outside Claude.ai. */
if (typeof window !== "undefined" && !window.storage) {
  window.storage = {
    async get(key) {
      const v = localStorage.getItem(key);
      if (v === null) throw new Error("not found");
      return { key, value: v, shared: false };
    },
    async set(key, value) {
      localStorage.setItem(key, value);
      return { key, value, shared: false };
    },
    async delete(key) {
      localStorage.removeItem(key);
      return { key, deleted: true, shared: false };
    },
    async list(prefix = "") {
      const keys = Object.keys(localStorage).filter((k) => k.startsWith(prefix));
      return { keys, prefix, shared: false };
    },
  };
}

function toPaise(rupeeString) {
  const n = parseFloat(rupeeString);
  if (!isFinite(n)) return NaN;
  return Math.round(n * 100);
}

function formatCurrency(paise, symbol = "\u20B9") {
  const sign = paise < 0 ? "-" : "";
  const abs = Math.abs(paise);
  const rupees = abs / 100;
  const hasFraction = Math.round(abs % 100) !== 0;
  const str = rupees.toLocaleString("en-IN", {
    minimumFractionDigits: hasFraction ? 2 : 0,
    maximumFractionDigits: 2,
  });
  return `${sign}${symbol}${str}`;
}

/** Distribute `amountPaise` across `weightsMap` {id: weight} proportionally,
 *  guaranteeing the parts sum exactly to amountPaise (largest-remainder method). */
function distributeByWeight(amountPaise, weightsMap) {
  const ids = Object.keys(weightsMap);
  const totalWeight = ids.reduce((s, id) => s + weightsMap[id], 0);
  const result = {};
  if (totalWeight <= 0 || ids.length === 0) return result;
  const raw = {};
  let flooredSum = 0;
  ids.forEach((id) => {
    const r = (amountPaise * weightsMap[id]) / totalWeight;
    raw[id] = r;
    result[id] = Math.floor(r);
    flooredSum += result[id];
  });
  let remainder = amountPaise - flooredSum;
  const byFraction = [...ids].sort((a, b) => {
    const fa = raw[a] - Math.floor(raw[a]);
    const fb = raw[b] - Math.floor(raw[b]);
    if (fb !== fa) return fb - fa;
    return a.localeCompare(b);
  });
  for (let i = 0; i < byFraction.length && remainder > 0; i++) {
    result[byFraction[i]] += 1;
    remainder -= 1;
  }
  return result;
}

/** Returns { memberId: paise } — each participant's fair share of one expense. */
function calculateExpenseShares(expense) {
  const participants = expense.participants || [];
  if (participants.length === 0) return {};
  const amount = expense.amountPaise || 0;

  if (expense.splitMode === "exact") {
    const out = {};
    participants.forEach((id) => (out[id] = expense.splitData?.[id] || 0));
    return out;
  }
  if (expense.splitMode === "percentage") {
    const weights = {};
    participants.forEach((id) => (weights[id] = expense.splitData?.[id] || 0));
    return distributeByWeight(amount, weights);
  }
  if (expense.splitMode === "shares") {
    const weights = {};
    participants.forEach((id) => (weights[id] = expense.splitData?.[id] || 0));
    return distributeByWeight(amount, weights);
  }
  // equal
  const weights = {};
  participants.forEach((id) => (weights[id] = 1));
  return distributeByWeight(amount, weights);
}

function calculateTotalPaid(expenses, members) {
  const out = {};
  members.forEach((m) => (out[m.id] = 0));
  expenses.forEach((e) => {
    if (e.paidBy && out[e.paidBy] !== undefined) out[e.paidBy] += e.amountPaise || 0;
  });
  return out;
}

/**
 * Computes each expense's rounded per-person shares AND the aggregate total share
 * per member, carrying the leftover fraction from each expense's rounding forward
 * into the next one a person takes part in (error-diffusion / Bresenham-style
 * rounding). Independent per-expense rounding can leave people who "should" end up
 * even a paisa or two apart purely from rounding order; carrying the remainder
 * forward keeps every expense's own split exact AND makes the aggregate as fair as
 * the numbers allow, cancelling out wherever the maths allows it to.
 */
function computeShareBreakdown(expenses, members) {
  const carry = {};
  members.forEach((m) => (carry[m.id] = 0));
  const perExpense = {};
  const totalShare = {};
  members.forEach((m) => (totalShare[m.id] = 0));

  expenses.forEach((e) => {
    const participants = e.participants || [];
    const amount = e.amountPaise || 0;
    if (participants.length === 0) {
      perExpense[e.id] = {};
      return;
    }

    if (e.splitMode === "exact") {
      const shares = {};
      participants.forEach((id) => (shares[id] = e.splitData?.[id] || 0));
      perExpense[e.id] = shares;
      participants.forEach((id) => {
        if (totalShare[id] !== undefined) totalShare[id] += shares[id];
      });
      return; // exact amounts are user-specified; nothing to carry
    }

    const weights = {};
    if (e.splitMode === "percentage" || e.splitMode === "shares") {
      participants.forEach((id) => (weights[id] = e.splitData?.[id] || 0));
    } else {
      participants.forEach((id) => (weights[id] = 1));
    }
    const totalWeight = participants.reduce((s, id) => s + (weights[id] || 0), 0);

    const raw = {};
    const adjusted = {};
    participants.forEach((id) => {
      raw[id] = totalWeight > 0 ? (amount * (weights[id] || 0)) / totalWeight : 0;
      adjusted[id] = raw[id] + (carry[id] || 0);
    });

    const rounded = {};
    let flooredSum = 0;
    participants.forEach((id) => {
      rounded[id] = Math.floor(adjusted[id]);
      flooredSum += rounded[id];
    });
    let remainder = amount - flooredSum;
    const byFraction = [...participants].sort((a, b) => {
      const fa = adjusted[a] - Math.floor(adjusted[a]);
      const fb = adjusted[b] - Math.floor(adjusted[b]);
      if (fb !== fa) return fb - fa;
      return a.localeCompare(b);
    });
    if (remainder >= 0) {
      for (let i = 0; i < byFraction.length && remainder > 0; i++) {
        rounded[byFraction[i]] += 1;
        remainder -= 1;
      }
    } else {
      for (let i = byFraction.length - 1; i >= 0 && remainder < 0; i--) {
        rounded[byFraction[i]] -= 1;
        remainder += 1;
      }
    }

    perExpense[e.id] = rounded;
    participants.forEach((id) => {
      if (totalShare[id] !== undefined) totalShare[id] += rounded[id];
      carry[id] = adjusted[id] - rounded[id];
    });
  });

  return { perExpense, totalShare };
}

function calculateTotalShare(expenses, members) {
  return computeShareBreakdown(expenses, members).totalShare;
}

function calculateBalances(totalPaid, totalShare, members) {
  const out = {};
  members.forEach((m) => (out[m.id] = (totalPaid[m.id] || 0) - (totalShare[m.id] || 0)));
  return out;
}

/** Greedy debt-simplification: minimum-ish number of transactions to settle a group. */
function calculateSettlements(balances) {
  const creditors = [];
  const debtors = [];
  Object.entries(balances).forEach(([id, bal]) => {
    if (bal > 0) creditors.push({ id, amount: bal });
    else if (bal < 0) debtors.push({ id, amount: -bal });
  });
  creditors.sort((a, b) => b.amount - a.amount);
  debtors.sort((a, b) => b.amount - a.amount);

  const transactions = [];
  let ci = 0, di = 0;
  while (ci < creditors.length && di < debtors.length) {
    const c = creditors[ci];
    const d = debtors[di];
    const amt = Math.min(c.amount, d.amount);
    if (amt > 0) transactions.push({ from: d.id, to: c.id, amount: amt });
    c.amount -= amt;
    d.amount -= amt;
    if (c.amount <= 0) ci++;
    if (d.amount <= 0) di++;
  }
  return transactions;
}

function validateMemberName(name, members, excludeId) {
  const trimmed = name.trim();
  if (!trimmed) return "Enter a name";
  const dup = members.some(
    (m) => m.id !== excludeId && m.name.trim().toLowerCase() === trimmed.toLowerCase()
  );
  if (dup) return "Someone already has this name";
  return null;
}

function validateExpenseDraft(draft) {
  const errors = {};
  if (!draft.name.trim()) errors.name = "Give this expense a name";
  const amount = toPaise(draft.amount);
  if (!draft.amount || isNaN(amount) || amount <= 0) {
    errors.amount = "Enter an amount greater than 0";
  }
  if (!draft.paidBy) errors.paidBy = "Choose who paid";
  if (!draft.participants || draft.participants.length === 0) {
    errors.participants = "Pick at least one person to split with";
  }
  if (!errors.amount && draft.participants?.length) {
    if (draft.splitMode === "exact") {
      const sum = draft.participants.reduce(
        (s, id) => s + (toPaise(draft.splitData?.[id]) || 0),
        0
      );
      if (sum !== amount) {
        errors.split = `Amounts add up to ${formatCurrency(sum)}, but the expense is ${formatCurrency(
          amount
        )}`;
      }
    } else if (draft.splitMode === "percentage") {
      const sum = draft.participants.reduce(
        (s, id) => s + (parseFloat(draft.splitData?.[id]) || 0),
        0
      );
      if (Math.round(sum * 100) !== 10000) {
        errors.split = `Percentages add up to ${sum || 0}%, they need to total 100%`;
      }
    } else if (draft.splitMode === "shares") {
      const invalid = draft.participants.some((id) => !(parseFloat(draft.splitData?.[id]) > 0));
      if (invalid) errors.split = "Every person needs at least 1 share";
    }
  }
  return errors;
}

/* Self-check against the worked example in the brief. Runs once, logs to console only. */
function runSelfCheck() {
  const members = [{ id: "deepak" }, { id: "rahul" }, { id: "aman" }];
  const mk = (name, amountPaise, paidBy) => ({
    name, amountPaise, paidBy, participants: ["deepak", "rahul", "aman"], splitMode: "equal",
  });
  const expenses = [
    mk("Domino's", 87000, "rahul"),
    mk("Subway + Cold Drink", 14000, "rahul"),
    mk("Bubble Tea", 28000, "rahul"),
    mk("Ice Cream", 11400, "deepak"),
  ];
  const paid = calculateTotalPaid(expenses, members);
  const share = calculateTotalShare(expenses, members);
  const bal = calculateBalances(paid, share, members);
  const settle = calculateSettlements(bal);
  const ok =
    paid.rahul === 129000 && paid.deepak === 11400 && paid.aman === 0 &&
    share.deepak === 46800 && share.rahul === 46800 && share.aman === 46800 &&
    bal.deepak === -35400 && bal.aman === -46800 &&
    settle.length === 2;
  console.log(ok ? "[SplitSmart] self-check passed" : "[SplitSmart] self-check FAILED", {
    paid, share, bal, settle,
  });
}

/* =========================================================================
   STATIC DATA
   ========================================================================= */

const CATEGORIES = [
  { id: "food", label: "Food", emoji: "\u{1F354}" },
  { id: "transport", label: "Transport", emoji: "\u{1F695}" },
  { id: "entertainment", label: "Entertainment", emoji: "\u{1F3AC}" },
  { id: "hotel", label: "Hotel", emoji: "\u{1F3E8}" },
  { id: "shopping", label: "Shopping", emoji: "\u{1F6CD}" },
  { id: "drinks", label: "Drinks", emoji: "\u2615" },
  { id: "other", label: "Other", emoji: "\u{1F4B0}" },
];
const catInfo = (id) => CATEGORIES.find((c) => c.id === id) || CATEGORIES[CATEGORIES.length - 1];

const AVATAR_PALETTE = ["#1F7A4D", "#B98900", "#3E6FB4", "#B4423C", "#7A5CC0", "#1F8F8F", "#C0685C"];
const avatarColor = (id) => {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return AVATAR_PALETTE[h % AVATAR_PALETTE.length];
};
const initials = (name) =>
  name.trim().split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() || "").join("") || "?";

/* =========================================================================
   SMALL PRESENTATIONAL PIECES
   ========================================================================= */

function Avatar({ id, name, size = 32 }) {
  return (
    <div
      className="ss-avatar"
      style={{ width: size, height: size, fontSize: size * 0.38, background: avatarColor(id) }}
    >
      {initials(name)}
    </div>
  );
}

function Field({ label, error, children, hint }) {
  return (
    <label className="ss-field">
      <span className="ss-field-label">{label}</span>
      {children}
      {hint && !error && <span className="ss-field-hint">{hint}</span>}
      {error && (
        <span className="ss-field-error">
          <AlertCircle size={13} /> {error}
        </span>
      )}
    </label>
  );
}

function Modal({ title, onClose, children, wide }) {
  useEffect(() => {
    const onKey = (e) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="ss-modal-veil" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={"ss-modal" + (wide ? " ss-modal-wide" : "")} role="dialog" aria-modal="true" aria-label={title}>
        <div className="ss-modal-head">
          <h3>{title}</h3>
          <button className="ss-icon-btn" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </div>
        <div className="ss-modal-body">{children}</div>
      </div>
    </div>
  );
}

function Toast({ message, onDone }) {
  useEffect(() => {
    const t = setTimeout(onDone, 2400);
    return () => clearTimeout(t);
  }, [onDone]);
  return (
    <div className="ss-toast" role="status">
      <Check size={15} /> {message}
    </div>
  );
}

/* =========================================================================
   MEMBER MANAGEMENT
   ========================================================================= */

function MemberBar({ members, onAdd, onRemove, blockedRemoval, onOpenProfile }) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState(null);
  const inputRef = useRef(null);

  useEffect(() => {
    if (adding) inputRef.current?.focus();
  }, [adding]);

  const submit = () => {
    const err = validateMemberName(name, members);
    if (err) return setError(err);
    onAdd(name.trim());
    setName("");
    setError(null);
    inputRef.current?.focus();
  };

  return (
    <div className="ss-memberbar">
      <div className="ss-memberbar-label">
        <Users size={15} /> People in this split
      </div>
      <div className="ss-chiprow">
        {members.map((m) => (
          <div key={m.id} className="ss-chip" onClick={() => onOpenProfile(m.id)}>
            <Avatar id={m.id} name={m.name} size={22} />
            <span>{m.name}</span>
            <button
              className="ss-chip-x"
              aria-label={`Remove ${m.name}`}
              onClick={(e) => {
                e.stopPropagation();
                onRemove(m.id);
              }}
            >
              <X size={12} />
            </button>
          </div>
        ))}
        {!adding && (
          <button className="ss-chip ss-chip-add" onClick={() => setAdding(true)}>
            <UserPlus size={15} /> Add person
          </button>
        )}
        {adding && (
          <div className="ss-chip-input">
            <input
              ref={inputRef}
              value={name}
              placeholder="Name"
              onChange={(e) => {
                setName(e.target.value);
                setError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") submit();
                if (e.key === "Escape") {
                  setAdding(false);
                  setName("");
                  setError(null);
                }
              }}
            />
            <button className="ss-icon-btn ss-icon-btn-solid" onClick={submit} aria-label="Add">
              <Check size={15} />
            </button>
            <button
              className="ss-icon-btn"
              onClick={() => {
                setAdding(false);
                setName("");
                setError(null);
              }}
              aria-label="Cancel"
            >
              <X size={15} />
            </button>
          </div>
        )}
      </div>
      {error && (
        <span className="ss-field-error" style={{ marginTop: 4 }}>
          <AlertCircle size={13} /> {error}
        </span>
      )}
      {blockedRemoval && (
        <span className="ss-field-error" style={{ marginTop: 4 }}>
          <AlertCircle size={13} /> {blockedRemoval} is in some expenses — remove those first, or reassign them.
        </span>
      )}
    </div>
  );
}

function MemberProfile({ member, expenses, paid, share, balance, perExpenseShares, onClose }) {
  const mine = expenses.filter(
    (e) => e.paidBy === member.id || e.participants.includes(member.id)
  );
  return (
    <Modal title={`${member.name}'s breakdown`} onClose={onClose}>
      <div className="ss-profile-head">
        <Avatar id={member.id} name={member.name} size={44} />
        <div>
          <div className="ss-profile-name">{member.name}</div>
          <div className={"ss-profile-status " + (balance > 0 ? "pos" : balance < 0 ? "neg" : "even")}>
            {balance > 0 && `Gets back ${formatCurrency(balance)}`}
            {balance < 0 && `Owes ${formatCurrency(-balance)}`}
            {balance === 0 && "All settled"}
          </div>
        </div>
      </div>
      <div className="ss-profile-stats">
        <div>
          <span>Paid</span>
          <strong>{formatCurrency(paid)}</strong>
        </div>
        <div>
          <span>Fair share</span>
          <strong>{formatCurrency(share)}</strong>
        </div>
      </div>
      <div className="ss-profile-list-label">Involved in {mine.length} expense{mine.length !== 1 ? "s" : ""}</div>
      <div className="ss-profile-list">
        {mine.map((e) => {
          const shares = perExpenseShares?.[e.id] || {};
          return (
            <div key={e.id} className="ss-profile-row">
              <span className="ss-profile-row-emoji">{catInfo(e.category).emoji}</span>
              <div className="ss-profile-row-main">
                <span>{e.name}</span>
                <span className="ss-muted">
                  {e.paidBy === member.id ? "Paid " + formatCurrency(e.amountPaise) : "Shared expense"}
                </span>
              </div>
              <span className="ss-profile-row-share">{formatCurrency(shares[member.id] || 0)}</span>
            </div>
          );
        })}
        {mine.length === 0 && <div className="ss-muted" style={{ padding: "8px 0" }}>No expenses yet.</div>}
      </div>
    </Modal>
  );
}

/* =========================================================================
   EXPENSES
   ========================================================================= */

function emptyDraft(members, currentSplitMode = "equal") {
  return {
    id: null,
    name: "",
    amount: "",
    paidBy: members[0]?.id || "",
    participants: members.map((m) => m.id),
    splitMode: currentSplitMode,
    splitData: {},
    category: "food",
    note: "",
  };
}

function ExpenseModal({ members, draft, setDraft, onSave, onClose, onDuplicate, isEdit }) {
  const [errors, setErrors] = useState({});
  const amountPaise = toPaise(draft.amount) || 0;

  const toggleParticipant = (id) => {
    setDraft((d) => {
      const has = d.participants.includes(id);
      const participants = has ? d.participants.filter((p) => p !== id) : [...d.participants, id];
      return { ...d, participants };
    });
  };

  const setSplitValue = (id, value) => {
    setDraft((d) => ({ ...d, splitData: { ...d.splitData, [id]: value } }));
  };

  const equalSplit = () => {
    if (!draft.participants.length) return {};
    return distributeByWeight(
      amountPaise,
      Object.fromEntries(draft.participants.map((id) => [id, 1]))
    );
  };

  const splitSumLabel = () => {
    if (draft.splitMode === "exact") {
      const sum = draft.participants.reduce((s, id) => s + (toPaise(draft.splitData?.[id]) || 0), 0);
      return `${formatCurrency(sum)} of ${formatCurrency(amountPaise)} assigned`;
    }
    if (draft.splitMode === "percentage") {
      const sum = draft.participants.reduce((s, id) => s + (parseFloat(draft.splitData?.[id]) || 0), 0);
      return `${sum || 0}% of 100% assigned`;
    }
    if (draft.splitMode === "shares") {
      const sum = draft.participants.reduce((s, id) => s + (parseFloat(draft.splitData?.[id]) || 0), 0);
      return `${sum || 0} total shares`;
    }
    return null;
  };

  const handleSave = () => {
    const errs = validateExpenseDraft(draft);
    setErrors(errs);
    if (Object.keys(errs).length) return;
    onSave({ ...draft, amountPaise: toPaise(draft.amount), id: draft.id || uid() });
  };

  const equalPreview = draft.splitMode === "equal" ? equalSplit() : null;

  return (
    <Modal title={isEdit ? "Edit expense" : "Add an expense"} onClose={onClose} wide>
      <div className="ss-grid2">
        <Field label="What was it for?" error={errors.name}>
          <input
            className="ss-input"
            placeholder="e.g. Domino's, Cab to airport"
            value={draft.name}
            onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
          />
        </Field>
        <Field label="Amount" error={errors.amount}>
          <div className="ss-input-prefix">
            <span>{"\u20B9"}</span>
            <input
              className="ss-input"
              inputMode="decimal"
              placeholder="0"
              value={draft.amount}
              onChange={(e) => setDraft((d) => ({ ...d, amount: e.target.value }))}
            />
          </div>
        </Field>
      </div>

      <div className="ss-grid2">
        <Field label="Paid by" error={errors.paidBy}>
          <div className="ss-select-avatars">
            {members.map((m) => (
              <button
                key={m.id}
                className={"ss-select-avatar" + (draft.paidBy === m.id ? " active" : "")}
                onClick={() => setDraft((d) => ({ ...d, paidBy: m.id }))}
                type="button"
              >
                <Avatar id={m.id} name={m.name} size={26} />
                <span>{m.name}</span>
              </button>
            ))}
          </div>
        </Field>
        <Field label="Category">
          <div className="ss-cat-row">
            {CATEGORIES.map((c) => (
              <button
                key={c.id}
                type="button"
                className={"ss-cat-pill" + (draft.category === c.id ? " active" : "")}
                onClick={() => setDraft((d) => ({ ...d, category: c.id }))}
                title={c.label}
              >
                {c.emoji}
              </button>
            ))}
          </div>
        </Field>
      </div>

      <Field label="Split between" error={errors.participants}>
        <div className="ss-select-avatars">
          {members.map((m) => (
            <button
              key={m.id}
              type="button"
              className={"ss-select-avatar" + (draft.participants.includes(m.id) ? " active" : "")}
              onClick={() => toggleParticipant(m.id)}
            >
              <Avatar id={m.id} name={m.name} size={26} />
              <span>{m.name}</span>
              {draft.participants.includes(m.id) && <Check size={12} className="ss-select-check" />}
            </button>
          ))}
        </div>
      </Field>

      <Field label="How should it be split?">
        <div className="ss-mode-row">
          {[
            { id: "equal", label: "Equal" },
            { id: "exact", label: "Custom amount" },
            { id: "percentage", label: "Percentage" },
            { id: "shares", label: "Shares" },
          ].map((mode) => (
            <button
              key={mode.id}
              type="button"
              className={"ss-mode-pill" + (draft.splitMode === mode.id ? " active" : "")}
              onClick={() => setDraft((d) => ({ ...d, splitMode: mode.id }))}
            >
              {mode.label}
            </button>
          ))}
        </div>
      </Field>

      {draft.splitMode !== "equal" && draft.participants.length > 0 && (
        <div className="ss-split-editor">
          {draft.participants.map((id) => {
            const m = members.find((mm) => mm.id === id);
            if (!m) return null;
            return (
              <div key={id} className="ss-split-row">
                <Avatar id={m.id} name={m.name} size={22} />
                <span className="ss-split-name">{m.name}</span>
                <div className="ss-split-input">
                  {draft.splitMode === "exact" && <span>{"\u20B9"}</span>}
                  <input
                    inputMode="decimal"
                    placeholder={draft.splitMode === "shares" ? "1" : "0"}
                    value={draft.splitData?.[id] ?? ""}
                    onChange={(e) => setSplitValue(id, e.target.value)}
                  />
                  {draft.splitMode === "percentage" && <span>%</span>}
                  {draft.splitMode === "shares" && <span>share(s)</span>}
                </div>
              </div>
            );
          })}
          <div className={"ss-split-total" + (errors.split ? " error" : "")}>
            {errors.split || splitSumLabel()}
          </div>
        </div>
      )}

      {draft.splitMode === "equal" && draft.participants.length > 0 && amountPaise > 0 && (
        <div className="ss-split-editor ss-split-preview">
          {draft.participants.map((id) => {
            const m = members.find((mm) => mm.id === id);
            if (!m) return null;
            return (
              <div key={id} className="ss-split-row">
                <Avatar id={m.id} name={m.name} size={22} />
                <span className="ss-split-name">{m.name}</span>
                <span className="ss-split-preview-amt">{formatCurrency(equalPreview[id] || 0)}</span>
              </div>
            );
          })}
        </div>
      )}

      <Field label="Note (optional)">
        <input
          className="ss-input"
          placeholder="Anything worth remembering about this one"
          value={draft.note}
          onChange={(e) => setDraft((d) => ({ ...d, note: e.target.value }))}
        />
      </Field>

      <div className="ss-modal-actions">
        {isEdit && (
          <button className="ss-btn ss-btn-ghost" onClick={() => onDuplicate(draft)}>
            <Copy size={15} /> Duplicate
          </button>
        )}
        <button className="ss-btn ss-btn-primary" onClick={handleSave}>
          {isEdit ? "Save changes" : "Add expense"}
        </button>
      </div>
    </Modal>
  );
}

function ExpenseRow({ expense, members, onEdit, onDelete }) {
  const payer = members.find((m) => m.id === expense.paidBy);
  const cat = catInfo(expense.category);
  return (
    <div className="ss-exp-row" style={{ "--accent": avatarColor(expense.paidBy || expense.id) }}>
      <span className="ss-exp-emoji">{cat.emoji}</span>
      <div className="ss-exp-main">
        <div className="ss-exp-top">
          <span className="ss-exp-name">{expense.name}</span>
          <span className="ss-exp-amount">{formatCurrency(expense.amountPaise)}</span>
        </div>
        <div className="ss-exp-sub">
          {payer ? `${payer.name} paid` : "Unassigned"} &middot; split {expense.splitMode === "equal" ? "equally" : expense.splitMode} among {expense.participants.length}
          {expense.note ? ` \u00b7 ${expense.note}` : ""}
        </div>
      </div>
      <div className="ss-exp-actions">
        <button className="ss-icon-btn" onClick={() => onEdit(expense)} aria-label="Edit expense">
          <Pencil size={15} />
        </button>
        <button className="ss-icon-btn ss-icon-btn-danger" onClick={() => onDelete(expense.id)} aria-label="Delete expense">
          <Trash2 size={15} />
        </button>
      </div>
    </div>
  );
}

/* =========================================================================
   SUMMARY / SETTLEMENT / SHARE
   ========================================================================= */

function buildExplanation(members, totalPaise, totalPaid, totalShare, settlements, currencySym) {
  const n = members.length;
  const lines = [];
  lines.push(
    `Total expenses: ${formatCurrency(totalPaise, currencySym)} across ${n} ${n === 1 ? "person" : "people"}.`
  );
  members.forEach((m) => {
    const paid = totalPaid[m.id] || 0;
    const share = totalShare[m.id] || 0;
    const diff = paid - share;
    if (diff === 0) {
      lines.push(`${m.name} paid ${formatCurrency(paid, currencySym)} against a fair share of ${formatCurrency(share, currencySym)} — already settled.`);
    } else if (diff > 0) {
      lines.push(`${m.name} paid ${formatCurrency(paid, currencySym)}, but their fair share is ${formatCurrency(share, currencySym)} — so ${m.name} should get back ${formatCurrency(diff, currencySym)}.`);
    } else {
      lines.push(`${m.name} paid ${formatCurrency(paid, currencySym)}, but their fair share is ${formatCurrency(share, currencySym)} — so ${m.name} owes ${formatCurrency(-diff, currencySym)}.`);
    }
  });
  if (settlements.length) {
    lines.push("To settle up with the fewest payments:");
    settlements.forEach((t) => {
      const from = members.find((m) => m.id === t.from)?.name || "?";
      const to = members.find((m) => m.id === t.to)?.name || "?";
      lines.push(`${from} pays ${to} ${formatCurrency(t.amount, currencySym)}.`);
    });
  } else {
    lines.push("Everyone already paid exactly their share — nothing left to settle.");
  }
  return lines;
}

function buildWhatsappMessage(members, totalPaise, totalShare, totalPaid, settlements, tripName) {
  const per = members.length ? Math.round(totalPaise / members.length) : 0;
  let msg = `${tripName ? tripName + " — " : ""}Bro, total ${formatCurrency(totalPaise)} hua for ${members.length} ${members.length === 1 ? "person" : "people"}, so roughly ${formatCurrency(per)}/person.\n\n`;
  members.forEach((m) => {
    const paid = totalPaid[m.id] || 0;
    const share = totalShare[m.id] || 0;
    const diff = paid - share;
    if (Math.abs(diff) < 1) {
      msg += `${m.name} settled hai already.\n`;
    } else if (diff > 0) {
      msg += `${m.name} ne extra pay kiya, ${formatCurrency(diff)} wapas milega.\n`;
    } else {
      msg += `${m.name} ne ${formatCurrency(paid)} pay kiye the, so ${formatCurrency(-diff)} remaining hai.\n`;
    }
  });
  if (settlements.length) {
    msg += `\nSettlement:\n`;
    settlements.forEach((t) => {
      const from = members.find((mm) => mm.id === t.from)?.name || "?";
      const to = members.find((mm) => mm.id === t.to)?.name || "?";
      msg += `${from} \u2192 ${to} ${formatCurrency(t.amount)}\n`;
    });
  }
  msg += `\nDone \u2705 — via SplitSmart`;
  return msg;
}

function SummaryPanel({
  members, expenses, totalPaid, totalShare, balances, settlements,
  totalPaise, tripName, onShareImage, onCopyMessage, generating,
}) {
  const [explOpen, setExplOpen] = useState(false);
  const explanation = useMemo(
    () => buildExplanation(members, totalPaise, totalPaid, totalShare, settlements),
    [members, totalPaise, totalPaid, totalShare, settlements]
  );
  const avg = members.length ? Math.round(totalPaise / members.length) : 0;
  const allSettled = expenses.length > 0 && settlements.length === 0;

  return (
    <div className="ss-summary" id="ss-summary-panel">
      <div className="ss-summary-badges">
        <span><Lock size={12} /> Nothing leaves your device</span>
        <span><Check size={12} /> Exact to the paisa</span>
        <span><Zap size={12} /> Updates instantly</span>
      </div>

      <div className="ss-summary-hero">
        <div>
          <span className="ss-summary-hero-label">Total expense</span>
          <span className="ss-summary-hero-value">{formatCurrency(totalPaise)}</span>
        </div>
        <div className="ss-summary-hero-split">
          <div>
            <span className="ss-summary-hero-label">People</span>
            <span>{members.length}</span>
          </div>
          <div>
            <span className="ss-summary-hero-label">Avg. share</span>
            <span>{formatCurrency(avg)}</span>
          </div>
        </div>
      </div>

      {allSettled && (
        <div className="ss-settled-banner">
          <PartyPopper size={18} /> All settled! Nobody owes anyone anything.
        </div>
      )}

      {members.length > 0 && expenses.length > 0 && (
        <>
          <div className="ss-summary-section">
            <h4>Who paid</h4>
            {members.map((m) => (
              <div className="ss-summary-line" key={m.id}>
                <span><Avatar id={m.id} name={m.name} size={20} /> {m.name}</span>
                <span>{formatCurrency(totalPaid[m.id] || 0)}</span>
              </div>
            ))}
          </div>

          <div className="ss-summary-section">
            <h4>Final share</h4>
            {members.map((m) => (
              <div className="ss-summary-line" key={m.id}>
                <span><Avatar id={m.id} name={m.name} size={20} /> {m.name}</span>
                <span>{formatCurrency(totalShare[m.id] || 0)}</span>
              </div>
            ))}
          </div>

          {!allSettled && (
            <div className="ss-summary-section">
              <h4>Settlement</h4>
              {settlements.map((t, i) => {
                const from = members.find((m) => m.id === t.from);
                const to = members.find((m) => m.id === t.to);
                return (
                  <div className="ss-settle-row" key={i}>
                    <span className="ss-settle-emoji">{"\u{1F4B8}"}</span>
                    <Avatar id={from?.id} name={from?.name || "?"} size={20} />
                    <span className="ss-settle-name">{from?.name}</span>
                    <ArrowRight size={14} className="ss-muted" />
                    <Avatar id={to?.id} name={to?.name || "?"} size={20} />
                    <span className="ss-settle-name">{to?.name}</span>
                    <span className="ss-settle-amt">{formatCurrency(t.amount)}</span>
                  </div>
                );
              })}
            </div>
          )}

          <button className="ss-collapse-toggle" onClick={() => setExplOpen((v) => !v)}>
            <span>How did we calculate this?</span>
            <ChevronDown size={16} style={{ transform: explOpen ? "rotate(180deg)" : "none" }} />
          </button>
          {explOpen && (
            <div className="ss-explanation">
              {explanation.map((line, i) => (
                <p key={i}>{line}</p>
              ))}
            </div>
          )}

          <div className="ss-summary-actions">
            <button className="ss-btn ss-btn-primary ss-btn-block" onClick={onShareImage} disabled={generating}>
              <Share2 size={16} /> {generating ? "Preparing image\u2026" : "Send summary \u{1F4F8}"}
            </button>
            <button className="ss-btn ss-btn-ghost ss-btn-block" onClick={onCopyMessage}>
              <Copy size={16} /> Copy message
            </button>
          </div>
        </>
      )}

      {expenses.length === 0 && (
        <div className="ss-summary-empty">Add an expense and your settlement will show up here.</div>
      )}
    </div>
  );
}

/* =========================================================================
   EMPTY STATE
   ========================================================================= */

function EmptyExpenses({ onAdd, hasMembers }) {
  return (
    <div className="ss-empty">
      <div className="ss-empty-icon"><ReceiptText size={30} /></div>
      <h3>No expenses yet.</h3>
      <p>Add your first expense and we'll handle the math.</p>
      <button className="ss-btn ss-btn-primary" onClick={onAdd} disabled={!hasMembers}>
        <Plus size={16} /> Add expense
      </button>
      {!hasMembers && <p className="ss-muted" style={{ marginTop: 10 }}>Add at least one person first.</p>}
    </div>
  );
}

/* =========================================================================
   HISTORY
   ========================================================================= */

function HistoryView({ splits, onOpen, onDuplicate, onDelete, onBack, loading }) {
  const [query, setQuery] = useState("");
  const filtered = splits.filter((s) => s.tripName.toLowerCase().includes(query.toLowerCase()));
  return (
    <div className="ss-history">
      <button className="ss-back" onClick={onBack}>
        <ChevronLeft size={16} /> Back to split
      </button>
      <div className="ss-history-head">
        <h2>Past splits</h2>
        <div className="ss-search">
          <Search size={15} />
          <input placeholder="Search by name" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
      </div>
      {loading && <div className="ss-muted">Loading{"\u2026"}</div>}
      {!loading && filtered.length === 0 && (
        <div className="ss-empty">
          <div className="ss-empty-icon"><History size={28} /></div>
          <h3>Nothing here yet.</h3>
          <p>Splits you create will show up in this list automatically.</p>
        </div>
      )}
      <div className="ss-history-list">
        {filtered.map((s) => {
          const settled = s.settlementCount === 0;
          return (
            <div className="ss-history-row" key={s.id}>
              <div className="ss-history-main" onClick={() => onOpen(s.id)}>
                <div className="ss-history-title">
                  <strong>{s.tripName || "Untitled split"}</strong>
                  <span className={"ss-status-pill " + (settled ? "settled" : "pending")}>
                    {settled ? "Settled" : `${s.settlementCount} to settle`}
                  </span>
                </div>
                <div className="ss-muted">
                  {s.tripDate || "No date"} {"\u00b7"} {s.memberCount} people {"\u00b7"} {formatCurrency(s.totalPaise)}
                </div>
              </div>
              <div className="ss-exp-actions">
                <button className="ss-icon-btn" onClick={() => onDuplicate(s.id)} aria-label="Duplicate">
                  <Copy size={15} />
                </button>
                <button className="ss-icon-btn ss-icon-btn-danger" onClick={() => onDelete(s.id)} aria-label="Delete">
                  <Trash2 size={15} />
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* =========================================================================
   MAIN APP
   ========================================================================= */

export default function App() {
  const [splitId, setSplitId] = useState(() => uid());
  const [tripName, setTripName] = useState("");
  const [tripDate, setTripDate] = useState("");
  const [members, setMembers] = useState([]);
  const [expenses, setExpenses] = useState([]);

  const [view, setView] = useState("app");
  const [expenseModal, setExpenseModal] = useState(null); // draft or null
  const [profileMemberId, setProfileMemberId] = useState(null);
  const [toast, setToast] = useState(null);
  const [blockedRemoval, setBlockedRemoval] = useState(null);
  const [generatingImage, setGeneratingImage] = useState(false);
  const [historySplits, setHistorySplits] = useState([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const canvasRef = useRef(null);

  useEffect(() => {
    runSelfCheck();
  }, []);

  useEffect(() => {
    if (blockedRemoval) {
      const t = setTimeout(() => setBlockedRemoval(null), 3500);
      return () => clearTimeout(t);
    }
  }, [blockedRemoval]);

  // --- derived calculations -------------------------------------------------
  const totalPaise = useMemo(() => expenses.reduce((s, e) => s + (e.amountPaise || 0), 0), [expenses]);
  const totalPaid = useMemo(() => calculateTotalPaid(expenses, members), [expenses, members]);
  const shareBreakdown = useMemo(() => computeShareBreakdown(expenses, members), [expenses, members]);
  const totalShare = shareBreakdown.totalShare;
  const balances = useMemo(() => calculateBalances(totalPaid, totalShare, members), [totalPaid, totalShare, members]);
  const settlements = useMemo(() => calculateSettlements(balances), [balances]);

  // --- persistence (window.storage) -----------------------------------------
  const saveTimer = useRef(null);
  useEffect(() => {
    if (members.length === 0 && expenses.length === 0 && !tripName) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      try {
        const record = {
          id: splitId, tripName, tripDate, members, expenses,
          totalPaise, memberCount: members.length, settlementCount: settlements.length,
          updatedAt: Date.now(),
        };
        await window.storage?.set(`splits:${splitId}`, JSON.stringify(record), false);
      } catch (err) {
        // best-effort persistence; app stays fully usable without it
        console.warn("SplitSmart: could not save split", err);
      }
    }, 700);
    return () => clearTimeout(saveTimer.current);
  }, [splitId, tripName, tripDate, members, expenses, totalPaise, settlements.length]);

  const loadHistory = useCallback(async () => {
    setHistoryLoading(true);
    try {
      const list = await window.storage?.list("splits:", false);
      const keys = list?.keys || [];
      const records = [];
      for (const key of keys) {
        try {
          const res = await window.storage.get(key, false);
          if (res?.value) records.push(JSON.parse(res.value));
        } catch {
          /* skip unreadable entries */
        }
      }
      records.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
      setHistorySplits(records);
    } catch (err) {
      console.warn("SplitSmart: could not load history", err);
      setHistorySplits([]);
    } finally {
      setHistoryLoading(false);
    }
  }, []);

  // --- member handlers --------------------------------------------------
  const addMember = (name) => setMembers((ms) => [...ms, { id: uid(), name }]);
  const removeMember = (id) => {
    const used = expenses.some((e) => e.paidBy === id || e.participants.includes(id));
    if (used) {
      const name = members.find((m) => m.id === id)?.name || "This person";
      setBlockedRemoval(name);
      return;
    }
    setMembers((ms) => ms.filter((m) => m.id !== id));
  };

  // --- expense handlers ---------------------------------------------------
  const openNewExpense = () => setExpenseModal(emptyDraft(members));
  const openEditExpense = (expense) =>
    setExpenseModal({
      ...expense,
      amount: (expense.amountPaise / 100).toString(),
      splitData: Object.fromEntries(
        Object.entries(expense.splitData || {}).map(([k, v]) => [
          k, expense.splitMode === "exact" ? (v / 100).toString() : String(v),
        ])
      ),
    });
  const saveExpense = (expense) => {
    const clean = { ...expense };
    if (clean.splitMode === "exact") {
      clean.splitData = Object.fromEntries(
        Object.entries(clean.splitData).map(([k, v]) => [k, toPaise(v) || 0])
      );
    } else if (clean.splitMode === "percentage" || clean.splitMode === "shares") {
      clean.splitData = Object.fromEntries(
        Object.entries(clean.splitData).map(([k, v]) => [k, parseFloat(v) || 0])
      );
    }
    delete clean.amount;
    setExpenses((es) => {
      const exists = es.some((e) => e.id === clean.id);
      return exists ? es.map((e) => (e.id === clean.id ? clean : e)) : [...es, clean];
    });
    setExpenseModal(null);
  };
  const deleteExpense = (id) => setExpenses((es) => es.filter((e) => e.id !== id));
  const duplicateExpense = (draft) => {
    setExpenseModal({ ...draft, id: null, name: draft.name + " (copy)" });
  };

  // --- new split / history -------------------------------------------------
  const startNewSplit = () => {
    setSplitId(uid());
    setTripName("");
    setTripDate("");
    setMembers([]);
    setExpenses([]);
    setView("app");
  };
  const openSplit = async (id) => {
    try {
      const res = await window.storage.get(`splits:${id}`, false);
      if (res?.value) {
        const rec = JSON.parse(res.value);
        setSplitId(rec.id);
        setTripName(rec.tripName || "");
        setTripDate(rec.tripDate || "");
        setMembers(rec.members || []);
        setExpenses(rec.expenses || []);
        setView("app");
      }
    } catch (err) {
      console.warn("SplitSmart: could not open split", err);
    }
  };
  const duplicateSplit = async (id) => {
    try {
      const res = await window.storage.get(`splits:${id}`, false);
      if (res?.value) {
        const rec = JSON.parse(res.value);
        setSplitId(uid());
        setTripName((rec.tripName || "Untitled") + " (copy)");
        setTripDate(rec.tripDate || "");
        setMembers(rec.members || []);
        setExpenses((rec.expenses || []).map((e) => ({ ...e, id: uid() })));
        setView("app");
      }
    } catch (err) {
      console.warn("SplitSmart: could not duplicate split", err);
    }
  };
  const deleteSplit = async (id) => {
    try {
      const res = await window.storage.get(`splits:${id}`, false);
      await window.storage.delete(`splits:${id}`, false, res?.value);
    } catch {
      /* ignore */
    }
    setHistorySplits((hs) => hs.filter((h) => h.id !== id));
  };

  // --- share / copy -----------------------------------------------------
  const showToast = (msg) => setToast(msg);

  const generateSummaryImage = async () => {
    setGeneratingImage(true);
    await new Promise((r) => setTimeout(r, 10));
    try {
      const W = 1080, H = 1350;
      const canvas = canvasRef.current || document.createElement("canvas");
      canvas.width = W;
      canvas.height = H;
      const ctx = canvas.getContext("2d");

      const bg = ctx.createLinearGradient(0, 0, 0, H);
      bg.addColorStop(0, "#123524");
      bg.addColorStop(1, "#0B2519");
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, W, H);

      // faint rupee pattern
      ctx.font = "700 64px sans-serif";
      ctx.fillStyle = "rgba(255,255,255,0.035)";
      for (let y = 40; y < H; y += 130) {
        for (let x = -40; x < W; x += 170) {
          ctx.fillText("\u20B9", x + ((y / 130) % 2) * 85, y);
        }
      }

      let y = 96;
      ctx.fillStyle = "#EFEFE8";
      ctx.font = "700 46px sans-serif";
      ctx.fillText("SplitSmart", 64, y);
      ctx.font = "600 22px sans-serif";
      ctx.fillStyle = "#8FBBA1";
      ctx.fillText("Split expenses. Settle up. No awkward math.", 64, y + 32);

      y += 96;
      ctx.strokeStyle = "rgba(255,255,255,0.14)";
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(64, y); ctx.lineTo(W - 64, y); ctx.stroke();

      y += 64;
      ctx.fillStyle = "#FFFFFF";
      ctx.font = "700 34px sans-serif";
      ctx.fillText(tripName || "Untitled split", 64, y);
      if (tripDate) {
        ctx.font = "500 20px sans-serif";
        ctx.fillStyle = "#8FBBA1";
        ctx.fillText(tripDate, 64, y + 30);
      }

      y += 70;
      ctx.font = "700 58px sans-serif";
      ctx.fillStyle = "#F4C94D";
      ctx.fillText(formatCurrency(totalPaise), 64, y);
      ctx.font = "500 22px sans-serif";
      ctx.fillStyle = "#8FBBA1";
      ctx.fillText(`total \u00b7 ${members.length} people \u00b7 ${formatCurrency(members.length ? Math.round(totalPaise / members.length) : 0)}/person`, 64, y + 34);

      y += 76;
      ctx.font = "700 24px sans-serif";
      ctx.fillStyle = "#EFEFE8";
      ctx.fillText("Expenses", 64, y);
      y += 20;
      expenses.slice(0, 8).forEach((e) => {
        y += 42;
        ctx.font = "500 24px sans-serif";
        ctx.fillStyle = "#D8E6DC";
        ctx.fillText(e.name, 64, y);
        ctx.textAlign = "right";
        ctx.fillStyle = "#F4C94D";
        ctx.fillText(formatCurrency(e.amountPaise), W - 64, y);
        ctx.textAlign = "left";
      });
      if (expenses.length > 8) {
        y += 42;
        ctx.font = "500 20px sans-serif";
        ctx.fillStyle = "#8FBBA1";
        ctx.fillText(`+ ${expenses.length - 8} more`, 64, y);
      }

      y += 60;
      ctx.strokeStyle = "rgba(255,255,255,0.14)";
      ctx.beginPath(); ctx.moveTo(64, y); ctx.lineTo(W - 64, y); ctx.stroke();

      y += 48;
      ctx.font = "700 26px sans-serif";
      ctx.fillStyle = "#EFEFE8";
      ctx.fillText("Settlement", 64, y);
      if (settlements.length === 0) {
        y += 42;
        ctx.font = "500 24px sans-serif";
        ctx.fillStyle = "#8FBBA1";
        ctx.fillText("All settled \u2014 nobody owes anyone.", 64, y);
      } else {
        settlements.slice(0, 6).forEach((t) => {
          y += 46;
          const from = members.find((m) => m.id === t.from)?.name || "?";
          const to = members.find((m) => m.id === t.to)?.name || "?";
          ctx.font = "600 25px sans-serif";
          ctx.fillStyle = "#D8E6DC";
          ctx.fillText(`${from} \u2192 ${to}`, 64, y);
          ctx.textAlign = "right";
          ctx.fillStyle = "#F4C94D";
          ctx.fillText(formatCurrency(t.amount), W - 64, y);
          ctx.textAlign = "left";
        });
      }

      ctx.font = "italic 500 20px sans-serif";
      ctx.fillStyle = "#8FBBA1";
      ctx.fillText('"SplitSmart \u2014 no awkward math."', 64, H - 56);

      canvas.toBlob(
        async (blob) => {
          if (!blob) { setGeneratingImage(false); return; }
          const file = new File([blob], `${(tripName || "splitsmart").replace(/\s+/g, "-")}.jpg`, { type: "image/jpeg" });
          if (navigator.share && navigator.canShare && navigator.canShare({ files: [file] })) {
            try {
              await navigator.share({ files: [file], title: "SplitSmart summary" });
              showToast("Shared!");
            } catch {
              /* user cancelled share sheet */
            }
          } else {
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = file.name;
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 4000);
            showToast("Image downloaded");
          }
          setGeneratingImage(false);
        },
        "image/jpeg",
        0.92
      );
    } catch (err) {
      console.warn("SplitSmart: image generation failed", err);
      setGeneratingImage(false);
    }
  };

  const copyMessage = async () => {
    const msg = buildWhatsappMessage(members, totalPaise, totalShare, totalPaid, settlements, tripName);
    try {
      await navigator.clipboard.writeText(msg);
      showToast("Message copied");
    } catch {
      const ta = document.createElement("textarea");
      ta.value = msg;
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand("copy"); showToast("Message copied"); } catch { /* noop */ }
      ta.remove();
    }
  };

  const scrollToSummary = () => {
    document.getElementById("ss-summary-panel")?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const profileMember = members.find((m) => m.id === profileMemberId);
  const allSettled = expenses.length > 0 && settlements.length === 0;

  return (
    <div className="ss-app">
      <Styles />
      <canvas ref={canvasRef} style={{ display: "none" }} aria-hidden="true" />

      <header className="ss-header">
        <div className="ss-header-inner">
          <div className="ss-brand">
            <div className="ss-brand-mark"><Wallet size={18} /></div>
            <div>
              <div className="ss-brand-name">SplitSmart</div>
              <div className="ss-brand-tag">Split expenses. Settle up. No awkward math.</div>
            </div>
          </div>
          <nav className="ss-nav">
            <button className="ss-nav-btn" onClick={startNewSplit}>
              <Plus size={15} /> New split
            </button>
            <button
              className="ss-nav-btn"
              onClick={() => {
                setView("history");
                loadHistory();
              }}
            >
              <History size={15} /> History
            </button>
          </nav>
        </div>
      </header>

      <main className="ss-main">
        {view === "history" ? (
          <HistoryView
            splits={historySplits}
            onOpen={openSplit}
            onDuplicate={duplicateSplit}
            onDelete={deleteSplit}
            onBack={() => setView("app")}
            loading={historyLoading}
          />
        ) : (
          <div className="ss-layout">
            <div className="ss-col-main">
              <section className="ss-card">
                <h2 className="ss-card-title">Start a new expense split</h2>
                <div className="ss-grid2">
                  <Field label="Trip / event name">
                    <input
                      className="ss-input"
                      placeholder="Movie + Dinner"
                      value={tripName}
                      onChange={(e) => setTripName(e.target.value)}
                    />
                  </Field>
                  <Field label="Date (optional)">
                    <input
                      type="date"
                      className="ss-input"
                      value={tripDate}
                      onChange={(e) => setTripDate(e.target.value)}
                    />
                  </Field>
                </div>
                <MemberBar
                  members={members}
                  onAdd={addMember}
                  onRemove={removeMember}
                  blockedRemoval={blockedRemoval}
                  onOpenProfile={setProfileMemberId}
                />
              </section>

              <section className="ss-card">
                <div className="ss-card-title-row">
                  <h2 className="ss-card-title">Expenses</h2>
                  {expenses.length > 0 && (
                    <button className="ss-btn ss-btn-primary ss-btn-sm" onClick={openNewExpense} disabled={members.length === 0}>
                      <Plus size={15} /> Add expense
                    </button>
                  )}
                </div>
                {expenses.length === 0 ? (
                  <EmptyExpenses onAdd={openNewExpense} hasMembers={members.length > 0} />
                ) : (
                  <div className="ss-exp-list">
                    {expenses.map((e) => (
                      <ExpenseRow key={e.id} expense={e} members={members} onEdit={openEditExpense} onDelete={deleteExpense} />
                    ))}
                  </div>
                )}
              </section>
            </div>

            <div className="ss-col-side">
              <SummaryPanel
                members={members}
                expenses={expenses}
                totalPaid={totalPaid}
                totalShare={totalShare}
                balances={balances}
                settlements={settlements}
                totalPaise={totalPaise}
                tripName={tripName}
                onShareImage={generateSummaryImage}
                onCopyMessage={copyMessage}
                generating={generatingImage}
              />
            </div>
          </div>
        )}
      </main>

      {view === "app" && expenses.length > 0 && (
        <button className="ss-sticky-cta" onClick={scrollToSummary}>
          {allSettled ? <><PartyPopper size={16} /> All settled</> : <>View settlement <ArrowRight size={16} /></>}
        </button>
      )}

      {expenseModal && (
        <ExpenseModal
          members={members}
          draft={expenseModal}
          setDraft={setExpenseModal}
          onSave={saveExpense}
          onClose={() => setExpenseModal(null)}
          onDuplicate={duplicateExpense}
          isEdit={!!expenses.find((e) => e.id === expenseModal.id)}
        />
      )}

      {profileMember && (
        <MemberProfile
          member={profileMember}
          expenses={expenses}
          paid={totalPaid[profileMember.id] || 0}
          share={totalShare[profileMember.id] || 0}
          balance={balances[profileMember.id] || 0}
          perExpenseShares={shareBreakdown.perExpense}
          onClose={() => setProfileMemberId(null)}
        />
      )}

      {toast && <Toast message={toast} onDone={() => setToast(null)} />}
    </div>
  );
}

/* =========================================================================
   STYLES
   ========================================================================= */

function Styles() {
  return (
    <style>{`
      .ss-app {
        --bg: #F5F8F3;
        --surface: #FFFFFF;
        --ink: #10241A;
        --ink-soft: #4E5F55;
        --line: #E2E9DD;
        --primary: #1F7A4D;
        --primary-dark: #155C39;
        --primary-soft: #E7F5EC;
        --gold: #A9780A;
        --gold-soft: #FBF3DE;
        --rose: #B4423C;
        --rose-soft: #FBEAE9;
        font-family: "IBM Plex Sans", "Segoe UI", system-ui, -apple-system, sans-serif;
        color: var(--ink);
        background: var(--bg);
        min-height: 100vh;
        background-image:
          radial-gradient(circle at 8% 12%, rgba(31,122,77,0.05), transparent 40%),
          radial-gradient(circle at 92% 85%, rgba(169,120,10,0.05), transparent 40%);
      }
      .ss-app * { box-sizing: border-box; }
      .ss-app button { font-family: inherit; cursor: pointer; }
      .ss-app input { font-family: inherit; }
      .ss-muted { color: var(--ink-soft); font-size: 13px; }

      .ss-header { position: sticky; top: 0; z-index: 20; background: rgba(245,248,243,0.9); backdrop-filter: blur(8px); border-bottom: 1px solid var(--line); }
      .ss-header-inner { max-width: 1180px; margin: 0 auto; padding: 14px 24px; display: flex; align-items: center; justify-content: space-between; gap: 16px; }
      .ss-brand { display: flex; align-items: center; gap: 10px; }
      .ss-brand-mark { width: 36px; height: 36px; border-radius: 10px; background: linear-gradient(135deg, var(--primary), var(--primary-dark)); color: white; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
      .ss-brand-name { font-family: "Space Grotesk", "IBM Plex Sans", sans-serif; font-weight: 700; font-size: 19px; line-height: 1.1; }
      .ss-brand-tag { font-size: 12px; color: var(--ink-soft); }
      .ss-nav { display: flex; gap: 8px; }
      .ss-nav-btn { display: flex; align-items: center; gap: 6px; padding: 8px 14px; border-radius: 999px; border: 1px solid var(--line); background: var(--surface); font-size: 13px; font-weight: 600; color: var(--ink); transition: transform .12s ease, box-shadow .12s ease, border-color .12s ease; }
      .ss-nav-btn:hover { border-color: var(--primary); box-shadow: 0 2px 10px rgba(31,122,77,0.12); transform: translateY(-1px); }

      .ss-main { max-width: 1180px; margin: 0 auto; padding: 28px 24px 100px; }
      .ss-layout { display: grid; grid-template-columns: 1.55fr 1fr; gap: 22px; align-items: start; }
      .ss-col-side { position: sticky; top: 84px; }

      .ss-card { background: var(--surface); border: 1px solid var(--line); border-radius: 18px; padding: 22px; margin-bottom: 20px; box-shadow: 0 1px 2px rgba(16,36,26,0.03); animation: ss-fade-up .35s ease both; }
      .ss-card-title { font-family: "Space Grotesk", sans-serif; font-size: 18px; font-weight: 700; margin: 0 0 16px; }
      .ss-card-title-row { display: flex; align-items: center; justify-content: space-between; margin-bottom: 4px; }
      .ss-card-title-row .ss-card-title { margin-bottom: 0; }

      .ss-grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; margin-bottom: 4px; }

      .ss-field { display: flex; flex-direction: column; gap: 6px; margin-bottom: 14px; }
      .ss-field-label { font-size: 12.5px; font-weight: 600; color: var(--ink-soft); }
      .ss-field-hint { font-size: 12px; color: var(--ink-soft); }
      .ss-field-error { display: flex; align-items: center; gap: 5px; font-size: 12.5px; color: var(--rose); }

      .ss-input { width: 100%; padding: 10px 12px; border-radius: 10px; border: 1px solid var(--line); background: #FCFDFB; font-size: 14.5px; color: var(--ink); transition: border-color .12s ease, box-shadow .12s ease; }
      .ss-input:focus { outline: none; border-color: var(--primary); box-shadow: 0 0 0 3px rgba(31,122,77,0.12); }
      .ss-input-prefix { display: flex; align-items: center; gap: 6px; border: 1px solid var(--line); border-radius: 10px; padding: 0 12px; background: #FCFDFB; }
      .ss-input-prefix span { color: var(--ink-soft); font-weight: 600; }
      .ss-input-prefix .ss-input { border: none; padding-left: 4px; background: transparent; }
      .ss-input-prefix:focus-within { border-color: var(--primary); box-shadow: 0 0 0 3px rgba(31,122,77,0.12); }

      .ss-memberbar { margin-top: 6px; }
      .ss-memberbar-label { display: flex; align-items: center; gap: 6px; font-size: 12.5px; font-weight: 600; color: var(--ink-soft); margin-bottom: 10px; }
      .ss-chiprow { display: flex; flex-wrap: wrap; gap: 8px; }
      .ss-chip { display: flex; align-items: center; gap: 7px; padding: 6px 10px 6px 6px; border-radius: 999px; background: var(--primary-soft); border: 1px solid transparent; font-size: 13.5px; font-weight: 600; cursor: pointer; transition: box-shadow .12s ease; }
      .ss-chip:hover { box-shadow: 0 2px 8px rgba(31,122,77,0.15); }
      .ss-chip-x { display: flex; align-items: center; justify-content: center; width: 16px; height: 16px; border-radius: 50%; background: rgba(16,36,26,0.08); border: none; color: var(--ink-soft); }
      .ss-chip-x:hover { background: var(--rose-soft); color: var(--rose); }
      .ss-chip-add { background: var(--surface); border: 1px dashed var(--line); color: var(--primary); }
      .ss-chip-add:hover { border-color: var(--primary); background: var(--primary-soft); }
      .ss-chip-input { display: flex; align-items: center; gap: 4px; background: var(--surface); border: 1px solid var(--primary); border-radius: 999px; padding: 4px 4px 4px 12px; }
      .ss-chip-input input { border: none; outline: none; font-size: 13.5px; width: 110px; background: transparent; }

      .ss-avatar { border-radius: 50%; color: white; display: flex; align-items: center; justify-content: center; font-weight: 700; flex-shrink: 0; font-family: "Space Grotesk", sans-serif; }

      .ss-exp-list { display: flex; flex-direction: column; }
      .ss-exp-row { display: flex; align-items: center; gap: 14px; padding: 14px 6px; border-bottom: 1px solid var(--line); border-left: 3px solid var(--accent); padding-left: 12px; border-radius: 8px; transition: background .12s ease, transform .12s ease; }
      .ss-exp-row:last-child { border-bottom: none; }
      .ss-exp-row:hover { background: #FAFBF8; transform: translateX(2px); }
      .ss-exp-emoji { font-size: 22px; flex-shrink: 0; }
      .ss-exp-main { flex: 1; min-width: 0; }
      .ss-exp-top { display: flex; justify-content: space-between; gap: 10px; font-weight: 600; }
      .ss-exp-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .ss-exp-amount { font-family: "Space Grotesk", sans-serif; font-variant-numeric: tabular-nums; flex-shrink: 0; }
      .ss-exp-sub { font-size: 12.5px; color: var(--ink-soft); margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .ss-exp-actions { display: flex; gap: 4px; flex-shrink: 0; }

      .ss-icon-btn { width: 32px; height: 32px; border-radius: 9px; border: 1px solid var(--line); background: var(--surface); display: flex; align-items: center; justify-content: center; color: var(--ink-soft); transition: all .12s ease; }
      .ss-icon-btn:hover { border-color: var(--primary); color: var(--primary); background: var(--primary-soft); }
      .ss-icon-btn-danger:hover { border-color: var(--rose); color: var(--rose); background: var(--rose-soft); }
      .ss-icon-btn-solid { background: var(--primary); color: white; border-color: var(--primary); }
      .ss-icon-btn-solid:hover { background: var(--primary-dark); color: white; }

      .ss-btn { display: inline-flex; align-items: center; justify-content: center; gap: 7px; padding: 11px 18px; border-radius: 12px; border: none; font-weight: 700; font-size: 14px; transition: transform .1s ease, box-shadow .12s ease, background .12s ease; }
      .ss-btn:disabled { opacity: .45; cursor: not-allowed; }
      .ss-btn-primary { background: var(--primary); color: white; box-shadow: 0 2px 10px rgba(31,122,77,0.25); }
      .ss-btn-primary:not(:disabled):hover { background: var(--primary-dark); transform: translateY(-1px); box-shadow: 0 4px 14px rgba(31,122,77,0.3); }
      .ss-btn-ghost { background: var(--surface); color: var(--ink); border: 1px solid var(--line); }
      .ss-btn-ghost:hover { border-color: var(--primary); color: var(--primary); }
      .ss-btn-sm { padding: 7px 13px; font-size: 13px; border-radius: 10px; }
      .ss-btn-block { width: 100%; }

      .ss-empty { text-align: center; padding: 42px 20px; }
      .ss-empty-icon { width: 56px; height: 56px; border-radius: 16px; background: var(--primary-soft); color: var(--primary); display: flex; align-items: center; justify-content: center; margin: 0 auto 14px; }
      .ss-empty h3 { margin: 0 0 4px; font-family: "Space Grotesk", sans-serif; }
      .ss-empty p { margin: 0 0 18px; color: var(--ink-soft); font-size: 14px; }

      .ss-summary { background: linear-gradient(165deg, #123524, #0B2519); color: #EFEFE8; border-radius: 18px; padding: 22px; animation: ss-fade-up .4s ease both; }
      .ss-summary-badges { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 18px; }
      .ss-summary-badges span { display: flex; align-items: center; gap: 5px; font-size: 11px; padding: 5px 9px; border-radius: 999px; background: rgba(255,255,255,0.08); color: #B9D6C2; }
      .ss-summary-hero { display: flex; justify-content: space-between; align-items: flex-end; margin-bottom: 18px; gap: 12px; }
      .ss-summary-hero-label { display: block; font-size: 11.5px; color: #8FBBA1; margin-bottom: 3px; }
      .ss-summary-hero-value { font-family: "Space Grotesk", sans-serif; font-size: 38px; font-weight: 700; font-variant-numeric: tabular-nums; color: #F4C94D; }
      .ss-summary-hero-split { display: flex; gap: 20px; text-align: right; }
      .ss-summary-hero-split div span:last-child { font-family: "Space Grotesk", sans-serif; font-weight: 700; font-size: 18px; }
      .ss-settled-banner { display: flex; align-items: center; gap: 8px; background: rgba(244,201,77,0.14); color: #F4C94D; padding: 10px 14px; border-radius: 12px; font-weight: 600; font-size: 13.5px; margin-bottom: 16px; }
      .ss-summary-section { margin-bottom: 16px; padding-top: 14px; border-top: 1px solid rgba(255,255,255,0.1); }
      .ss-summary-section h4 { margin: 0 0 10px; font-size: 12.5px; text-transform: none; color: #8FBBA1; font-weight: 600; }
      .ss-summary-line { display: flex; align-items: center; justify-content: space-between; padding: 5px 0; font-size: 14px; }
      .ss-summary-line span:first-child { display: flex; align-items: center; gap: 8px; }
      .ss-summary-line span:last-child { font-family: "Space Grotesk", sans-serif; font-variant-numeric: tabular-nums; }
      .ss-settle-row { display: flex; align-items: center; gap: 8px; padding: 8px 10px; background: rgba(255,255,255,0.06); border-radius: 10px; margin-bottom: 6px; font-size: 13.5px; }
      .ss-settle-name { font-weight: 600; }
      .ss-settle-amt { margin-left: auto; font-family: "Space Grotesk", sans-serif; color: #F4C94D; font-weight: 700; font-variant-numeric: tabular-nums; }
      .ss-collapse-toggle { width: 100%; display: flex; align-items: center; justify-content: space-between; background: transparent; border: none; border-top: 1px solid rgba(255,255,255,0.1); padding: 14px 0 8px; color: #EFEFE8; font-weight: 600; font-size: 13.5px; }
      .ss-explanation { font-size: 13px; color: #C6DCCB; line-height: 1.6; padding-bottom: 8px; }
      .ss-explanation p { margin: 0 0 8px; }
      .ss-summary-actions { display: flex; flex-direction: column; gap: 8px; margin-top: 16px; }
      .ss-summary-empty { color: #8FBBA1; font-size: 13.5px; padding: 6px 0 2px; }

      .ss-sticky-cta { display: none; }

      .ss-select-avatars { display: flex; flex-wrap: wrap; gap: 8px; }
      .ss-select-avatar { position: relative; display: flex; align-items: center; gap: 6px; padding: 6px 10px 6px 6px; border-radius: 999px; border: 1px solid var(--line); background: var(--surface); font-size: 13px; font-weight: 600; }
      .ss-select-avatar.active { border-color: var(--primary); background: var(--primary-soft); color: var(--primary-dark); }
      .ss-select-check { color: var(--primary); }

      .ss-cat-row { display: flex; flex-wrap: wrap; gap: 6px; }
      .ss-cat-pill { width: 34px; height: 34px; border-radius: 10px; border: 1px solid var(--line); background: var(--surface); font-size: 16px; display: flex; align-items: center; justify-content: center; }
      .ss-cat-pill.active { border-color: var(--gold); background: var(--gold-soft); }

      .ss-mode-row { display: flex; flex-wrap: wrap; gap: 8px; }
      .ss-mode-pill { padding: 8px 14px; border-radius: 999px; border: 1px solid var(--line); background: var(--surface); font-size: 13px; font-weight: 600; }
      .ss-mode-pill.active { background: var(--primary); border-color: var(--primary); color: white; }

      .ss-split-editor { background: #FAFBF8; border: 1px solid var(--line); border-radius: 12px; padding: 12px; margin-bottom: 14px; }
      .ss-split-row { display: flex; align-items: center; gap: 10px; padding: 6px 0; }
      .ss-split-name { flex: 1; font-size: 13.5px; font-weight: 600; }
      .ss-split-input { display: flex; align-items: center; gap: 5px; border: 1px solid var(--line); border-radius: 8px; padding: 4px 8px; background: white; }
      .ss-split-input input { width: 70px; border: none; outline: none; font-size: 13.5px; text-align: right; }
      .ss-split-input span { font-size: 12px; color: var(--ink-soft); }
      .ss-split-preview-amt { font-family: "Space Grotesk", sans-serif; font-weight: 700; font-variant-numeric: tabular-nums; }
      .ss-split-total { margin-top: 6px; padding-top: 8px; border-top: 1px dashed var(--line); font-size: 12.5px; color: var(--ink-soft); font-weight: 600; }
      .ss-split-total.error { color: var(--rose); }
      .ss-split-preview { background: var(--primary-soft); }

      .ss-modal-actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 8px; }

      .ss-modal-veil { position: fixed; inset: 0; background: rgba(16,36,26,0.45); backdrop-filter: blur(2px); display: flex; align-items: flex-end; justify-content: center; z-index: 50; animation: ss-veil-in .15s ease both; }
      .ss-modal { background: var(--surface); width: 100%; max-width: 480px; max-height: 88vh; overflow-y: auto; border-radius: 20px 20px 0 0; padding: 20px; animation: ss-modal-in .22s cubic-bezier(.2,.8,.3,1) both; }
      .ss-modal-wide { max-width: 620px; }
      .ss-modal-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px; }
      .ss-modal-head h3 { margin: 0; font-family: "Space Grotesk", sans-serif; font-size: 18px; }

      .ss-profile-head { display: flex; align-items: center; gap: 12px; margin-bottom: 16px; }
      .ss-profile-name { font-weight: 700; font-size: 16px; }
      .ss-profile-status.pos { color: var(--primary); font-size: 13px; font-weight: 600; }
      .ss-profile-status.neg { color: var(--rose); font-size: 13px; font-weight: 600; }
      .ss-profile-status.even { color: var(--ink-soft); font-size: 13px; font-weight: 600; }
      .ss-profile-stats { display: flex; gap: 12px; margin-bottom: 18px; }
      .ss-profile-stats div { flex: 1; background: #FAFBF8; border: 1px solid var(--line); border-radius: 12px; padding: 10px 12px; }
      .ss-profile-stats span { display: block; font-size: 11.5px; color: var(--ink-soft); }
      .ss-profile-stats strong { font-family: "Space Grotesk", sans-serif; font-size: 17px; }
      .ss-profile-list-label { font-size: 12.5px; font-weight: 600; color: var(--ink-soft); margin-bottom: 8px; }
      .ss-profile-row { display: flex; align-items: center; gap: 10px; padding: 8px 0; border-bottom: 1px solid var(--line); }
      .ss-profile-row:last-child { border-bottom: none; }
      .ss-profile-row-emoji { font-size: 17px; }
      .ss-profile-row-main { flex: 1; display: flex; flex-direction: column; }
      .ss-profile-row-share { font-family: "Space Grotesk", sans-serif; font-weight: 700; }

      .ss-toast { position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%); background: var(--ink); color: white; padding: 10px 18px; border-radius: 999px; display: flex; align-items: center; gap: 8px; font-size: 13.5px; font-weight: 600; z-index: 60; box-shadow: 0 8px 24px rgba(0,0,0,0.25); animation: ss-toast-in .2s ease both; }

      .ss-back { display: flex; align-items: center; gap: 4px; background: none; border: none; color: var(--ink-soft); font-size: 13px; font-weight: 600; margin-bottom: 12px; }
      .ss-back:hover { color: var(--primary); }
      .ss-history-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 18px; flex-wrap: wrap; }
      .ss-history-head h2 { font-family: "Space Grotesk", sans-serif; margin: 0; }
      .ss-search { display: flex; align-items: center; gap: 8px; border: 1px solid var(--line); background: var(--surface); border-radius: 999px; padding: 8px 14px; color: var(--ink-soft); }
      .ss-search input { border: none; outline: none; background: transparent; font-size: 13.5px; width: 180px; }
      .ss-history-list { display: flex; flex-direction: column; gap: 10px; }
      .ss-history-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; background: var(--surface); border: 1px solid var(--line); border-radius: 14px; padding: 14px 16px; }
      .ss-history-main { flex: 1; cursor: pointer; }
      .ss-history-title { display: flex; align-items: center; gap: 10px; margin-bottom: 4px; }
      .ss-status-pill { font-size: 11px; font-weight: 700; padding: 2px 9px; border-radius: 999px; }
      .ss-status-pill.settled { background: var(--primary-soft); color: var(--primary-dark); }
      .ss-status-pill.pending { background: var(--gold-soft); color: var(--gold); }

      @keyframes ss-fade-up { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
      @keyframes ss-veil-in { from { opacity: 0; } to { opacity: 1; } }
      @keyframes ss-modal-in { from { opacity: 0; transform: translateY(24px); } to { opacity: 1; transform: translateY(0); } }
      @keyframes ss-toast-in { from { opacity: 0; transform: translate(-50%, 8px); } to { opacity: 1; transform: translate(-50%, 0); } }

      @media (prefers-reduced-motion: reduce) {
        .ss-card, .ss-summary, .ss-modal, .ss-toast { animation: none !important; }
      }

      @media (max-width: 900px) {
        .ss-layout { grid-template-columns: 1fr; }
        .ss-col-side { position: static; }
        .ss-brand-tag { display: none; }
        .ss-header-inner { padding: 12px 16px; }
        .ss-main { padding: 20px 16px 90px; }
        .ss-grid2 { grid-template-columns: 1fr; }
        .ss-nav-btn span { display: none; }
        .ss-sticky-cta {
          display: flex; align-items: center; justify-content: center; gap: 8px;
          position: fixed; left: 16px; right: 16px; bottom: 16px; z-index: 40;
          background: var(--primary); color: white; border: none; border-radius: 14px;
          padding: 14px; font-weight: 700; font-size: 14.5px;
          box-shadow: 0 8px 24px rgba(31,122,77,0.35);
        }
      }

      @media (max-width: 480px) {
        .ss-modal { max-height: 92vh; }
        .ss-select-avatars, .ss-cat-row, .ss-mode-row { gap: 6px; }
      }
    `}</style>
  );
}
