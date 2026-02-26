import React from 'react';
import { WhatsAppHandler } from '@/messenger/whatsapp/WhatsAppHandler';
import { TelegramHandler } from '@/messenger/telegram/TelegramHandler';
import { GenericChannelHandler } from '@/messenger/shared/GenericChannelHandler';
import { ChannelPairingHeader } from './ChannelPairingHeader';
import { ChannelPairingTabBar } from './ChannelPairingTabBar';
import { BridgeAccountPanel } from './BridgeAccountPanel';
import { ActivityLogPanel } from './ActivityLogPanel';
import { useChannelPairingController } from './useChannelPairingController';
import type { ChannelPairingProps } from './types';

const ChannelPairing: React.FC<ChannelPairingProps> = ({
  coupledChannels,
  onUpdateCoupling,
  onSimulateIncoming,
}) => {
  const {
    activeTab,
    setActiveTab,
    pairingLogs,
    inputToken,
    setInputToken,
    simMessage,
    setSimMessage,
    pairingCode,
    setPairingCode,
    isConfirmingCode,
    activeBridgeTab,
    activeAccountSelectId,
    newAccountInputId,
    allowFromInputId,
    selectedBridgeAccount,
    setSelectedBridgeAccount,
    newBridgeAccountDraft,
    setNewBridgeAccountDraft,
    allowFromInput,
    setAllowFromInput,
    isSavingAllowFrom,
    accountOptions,
    currentChannel,
    startPairing,
    confirmTelegramPairingCode,
    disconnect,
    applyNewAccountId,
    saveAllowFrom,
    handleSimulate,
  } = useChannelPairingController({
    coupledChannels,
    onUpdateCoupling,
    onSimulateIncoming,
  });

  return (
    <div className="mx-auto max-w-6xl space-y-6 pb-12">
      <ChannelPairingHeader coupledChannels={coupledChannels} />

      <ChannelPairingTabBar
        activeTab={activeTab}
        coupledChannels={coupledChannels}
        onSelectTab={setActiveTab}
      />

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
        <div className="space-y-4 xl:col-span-2">
          {activeBridgeTab && (
            <BridgeAccountPanel
              activeBridgeTab={activeBridgeTab}
              activeTab={activeTab}
              activeAccountSelectId={activeAccountSelectId}
              newAccountInputId={newAccountInputId}
              allowFromInputId={allowFromInputId}
              selectedBridgeAccount={selectedBridgeAccount}
              accountOptions={accountOptions}
              newBridgeAccountDraft={newBridgeAccountDraft}
              allowFromInput={allowFromInput}
              isSavingAllowFrom={isSavingAllowFrom}
              onSelectBridgeAccount={(accountId) =>
                setSelectedBridgeAccount((prev) => ({ ...prev, [activeBridgeTab]: accountId }))
              }
              onChangeNewAccountDraft={(value) =>
                setNewBridgeAccountDraft((prev) => ({ ...prev, [activeBridgeTab]: value }))
              }
              onApplyNewAccountId={applyNewAccountId}
              onChangeAllowFrom={setAllowFromInput}
              onSaveAllowFrom={saveAllowFrom}
            />
          )}

          <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-6">
            {activeTab === 'whatsapp' && (
              <WhatsAppHandler
                channel={currentChannel}
                onStartPairing={startPairing}
                onDisconnect={disconnect}
                simMessage={simMessage}
                setSimMessage={setSimMessage}
                onSimulate={handleSimulate}
              />
            )}
            {activeTab === 'telegram' && (
              <TelegramHandler
                channel={currentChannel}
                onStartPairing={startPairing}
                onConfirmPairingCode={confirmTelegramPairingCode}
                onDisconnect={disconnect}
                pairingCode={pairingCode}
                setPairingCode={setPairingCode}
                isConfirmingCode={isConfirmingCode}
                token={inputToken}
                setToken={setInputToken}
                simMessage={simMessage}
                setSimMessage={setSimMessage}
                onSimulate={handleSimulate}
              />
            )}
            {activeTab === 'discord' && (
              <GenericChannelHandler
                channel={currentChannel}
                title="Discord Bot"
                icon="👾"
                description="Use a Discord Bot Token to relay server and DM messages."
                accent="indigo"
                token={inputToken}
                setToken={setInputToken}
                tokenPlaceholder="DISCORD_BOT_TOKEN_KEY"
                simMessage={simMessage}
                setSimMessage={setSimMessage}
                onStartPairing={startPairing}
                onDisconnect={disconnect}
                onSimulate={handleSimulate}
              />
            )}
            {activeTab === 'imessage' && (
              <GenericChannelHandler
                channel={currentChannel}
                title="iMessage Bridge"
                icon="☁️"
                description="Relay iMessages through a local smid-enabled macOS node."
                accent="sky"
                simMessage={simMessage}
                setSimMessage={setSimMessage}
                onStartPairing={startPairing}
                onDisconnect={disconnect}
                onSimulate={handleSimulate}
              />
            )}
            {activeTab === 'slack' && (
              <GenericChannelHandler
                channel={currentChannel}
                title="Slack Bot"
                icon="🟦"
                description="Connect a Slack Bot Token for channel and DM relay."
                accent="indigo"
                token={inputToken}
                setToken={setInputToken}
                tokenPlaceholder="SLACK_BOT_TOKEN"
                simMessage={simMessage}
                setSimMessage={setSimMessage}
                onStartPairing={startPairing}
                onDisconnect={disconnect}
                onSimulate={handleSimulate}
              />
            )}
          </div>
        </div>

        <ActivityLogPanel pairingLogs={pairingLogs} />
      </div>
    </div>
  );
};

export default ChannelPairing;
