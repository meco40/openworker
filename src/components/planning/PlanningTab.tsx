'use client';

import type { PlanningTabProps } from './types';
import { PlanningTabView } from './PlanningTabView';
import { usePlanningTabController } from './usePlanningTabController';

export function PlanningTab(props: PlanningTabProps) {
  const controller = usePlanningTabController(props);

  return (
    <PlanningTabView
      state={controller.state}
      loading={controller.loading}
      starting={controller.starting}
      submitting={controller.submitting}
      canceling={controller.canceling}
      error={controller.error}
      otherText={controller.otherText}
      selectedOption={controller.selectedOption}
      isWaitingForResponse={controller.isWaitingForResponse}
      retryingDispatch={controller.retryingDispatch}
      isSubmittingAnswer={controller.isSubmittingAnswer}
      isRefreshingFallback={controller.isRefreshingFallback}
      fallbackRefreshError={controller.fallbackRefreshError}
      hasRetrySubmission={controller.hasRetrySubmission}
      onOtherTextChange={controller.setOtherText}
      onSelectOption={controller.setSelectedOption}
      onStartPlanning={controller.startPlanning}
      onSubmitAnswer={controller.submitAnswer}
      onRetry={controller.handleRetry}
      onRetryDispatch={controller.retryDispatch}
      onFallbackRefresh={controller.triggerFallbackRefresh}
      onCancelPlanning={controller.cancelPlanning}
    />
  );
}
