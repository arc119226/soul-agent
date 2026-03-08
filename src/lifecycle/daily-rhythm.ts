/**
 * Daily rhythm engine — maps time of day to behavior phases.
 */

import { getTimeOfDay, type TimeOfDay } from './awareness.js';

export type DailyPhase =
  | 'greeting'
  | 'active_service'
  | 'reflection'
  | 'rest'
  | 'dormant';

export interface PhaseInfo {
  phase: DailyPhase;
  timeOfDay: TimeOfDay;
  description: string;
  proactiveLevel: number; // 0-1, how proactive bot should be
}

const PHASE_MAP: Record<TimeOfDay, PhaseInfo> = {
  morning: {
    phase: 'greeting',
    timeOfDay: 'morning',
    description: '早晨問候模式——考慮發送早安訊息',
    proactiveLevel: 0.8,
  },
  day: {
    phase: 'active_service',
    timeOfDay: 'day',
    description: '日間活躍服務模式——全力回應需求',
    proactiveLevel: 1.0,
  },
  evening: {
    phase: 'reflection',
    timeOfDay: 'evening',
    description: '傍晚反思模式——觸發每日反思',
    proactiveLevel: 0.5,
  },
  night: {
    phase: 'rest',
    timeOfDay: 'night',
    description: '夜間休息模式——減少主動行為',
    proactiveLevel: 0.2,
  },
  deep_night: {
    phase: 'dormant',
    timeOfDay: 'deep_night',
    description: '深夜休眠模式——最低心跳',
    proactiveLevel: 0,
  },
};

export function getDailyPhase(): PhaseInfo {
  const timeOfDay = getTimeOfDay();
  return PHASE_MAP[timeOfDay];
}

export type RecommendedAction =
  | 'send_greeting'
  | 'be_available'
  | 'trigger_reflection'
  | 'reduce_activity'
  | 'enter_dormant'
  | 'none';

export function getRecommendedAction(): RecommendedAction {
  const { phase } = getDailyPhase();
  switch (phase) {
    case 'greeting':
      return 'send_greeting';
    case 'active_service':
      return 'be_available';
    case 'reflection':
      return 'trigger_reflection';
    case 'rest':
      return 'reduce_activity';
    case 'dormant':
      return 'enter_dormant';
    default:
      return 'none';
  }
}
