// Built-in writing prompts for the Today view. One per day, rotating; "Another" steps through.
import { parseDate } from '../lib/dates'

export const PROMPTS = [
  'What made you smile today?',
  'What is one thing you learned today?',
  'Who did you talk to today, and what stayed with you?',
  'What are three things you are grateful for right now?',
  'What was the hardest part of today, and how did you handle it?',
  'Describe where you are right now using all five senses.',
  'What are you looking forward to this week?',
  'What would make tomorrow a good day?',
  'What is something you did today just for yourself?',
  'What surprised you recently?',
  'What has been on your mind the most lately?',
  'Write about a small win from today.',
  'What is something you want to remember about this year?',
  'How did you feel when you woke up, and how do you feel now?',
  'What did you eat today, and who did you share it with?',
  'Write a short letter to yourself one year from now.',
  'What is a habit you would like to start or stop?',
  'Describe a place that makes you feel calm.',
  'What did you notice today that you usually overlook?',
  'Which song, book or film has been with you lately, and why?',
  'What is a decision you are thinking about?',
  'What gave you energy today, and what drained it?',
  'Write about someone you miss.',
  'What would you tell your younger self about today?',
  'What are you proud of this month?',
  'What did you do today that future you will thank you for?',
  'What made today different from yesterday?',
  'What is a question you keep coming back to?',
  'Describe the weather, and how it matched your mood.',
  'If today had a title, what would it be?',
] as const

function dayNumber(date: string): number {
  return Math.floor(parseDate(date).getTime() / 86_400_000)
}

/** The prompt for a day, or the one `offset` steps after it. */
export function promptFor(date: string, offset = 0): string {
  const n = PROMPTS.length
  return PROMPTS[(((dayNumber(date) + offset) % n) + n) % n]
}
