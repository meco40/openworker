import type { ActiveTab, BridgeTab } from './types';

type BridgeAccountPanelProps = {
  activeBridgeTab: BridgeTab;
  activeTab: ActiveTab;
  activeAccountSelectId: string;
  newAccountInputId: string;
  allowFromInputId: string;
  selectedBridgeAccount: Record<BridgeTab, string>;
  accountOptions: string[];
  newBridgeAccountDraft: Record<BridgeTab, string>;
  allowFromInput: string;
  isSavingAllowFrom: boolean;
  onSelectBridgeAccount: (accountId: string) => void;
  onChangeNewAccountDraft: (value: string) => void;
  onApplyNewAccountId: () => void;
  onChangeAllowFrom: (value: string) => void;
  onSaveAllowFrom: () => void;
};

export function BridgeAccountPanel({
  activeBridgeTab,
  activeTab,
  activeAccountSelectId,
  newAccountInputId,
  allowFromInputId,
  selectedBridgeAccount,
  accountOptions,
  newBridgeAccountDraft,
  allowFromInput,
  isSavingAllowFrom,
  onSelectBridgeAccount,
  onChangeNewAccountDraft,
  onApplyNewAccountId,
  onChangeAllowFrom,
  onSaveAllowFrom,
}: BridgeAccountPanelProps) {
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-5">
      <h4 className="mb-4 text-xs font-semibold tracking-widest text-zinc-400 uppercase">
        Account - {activeBridgeTab.toUpperCase()}
      </h4>
      <div className="flex flex-wrap gap-3">
        <div className="flex flex-col gap-1.5">
          <label htmlFor={activeAccountSelectId} className="text-xs text-zinc-500">
            Active
          </label>
          <select
            id={activeAccountSelectId}
            value={selectedBridgeAccount[activeBridgeTab]}
            onChange={(event) => onSelectBridgeAccount(event.target.value)}
            className="rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-white focus:border-zinc-500 focus:outline-none"
          >
            {accountOptions.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
        </div>
        <div className="flex min-w-40 flex-1 flex-col gap-1.5">
          <label htmlFor={newAccountInputId} className="text-xs text-zinc-500">
            Add Account
          </label>
          <div className="flex gap-2">
            <input
              id={newAccountInputId}
              value={newBridgeAccountDraft[activeBridgeTab]}
              onChange={(event) => onChangeNewAccountDraft(event.target.value)}
              onKeyDown={(event) => event.key === 'Enter' && onApplyNewAccountId()}
              placeholder="e.g. support"
              className="flex-1 rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-white placeholder-zinc-600 focus:border-zinc-500 focus:outline-none"
            />
            <button
              onClick={onApplyNewAccountId}
              className="rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm font-medium text-zinc-200 transition-colors hover:bg-zinc-700"
            >
              Use
            </button>
          </div>
        </div>
      </div>
      {activeTab === 'whatsapp' && (
        <div className="mt-4 border-t border-zinc-800 pt-4">
          <div className="flex flex-col gap-1.5">
            <label htmlFor={allowFromInputId} className="text-xs text-zinc-500">
              Allow From{' '}
              <span className="text-zinc-600">- optional comma-separated sender filters</span>
            </label>
            <div className="flex gap-2">
              <input
                id={allowFromInputId}
                value={allowFromInput}
                onChange={(event) => onChangeAllowFrom(event.target.value)}
                placeholder="+49123, +49888, sales-team"
                className="flex-1 rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-white placeholder-zinc-600 focus:border-zinc-500 focus:outline-none"
              />
              <button
                onClick={onSaveAllowFrom}
                disabled={isSavingAllowFrom}
                className="rounded-lg bg-emerald-700 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-emerald-600 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isSavingAllowFrom ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
