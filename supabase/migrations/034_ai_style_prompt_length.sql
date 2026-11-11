-- AI photo style prompts up to 12 000 characters (asked 2026-11-11: the team's NAS prompts run ~5 000; the app's
-- CT_AI_STYLE_PROMPT_MAX in customize-tool/lib/ai-style-models.ts). The old check stopped at 4 000.
alter table flexiprint.ct_ai_styles drop constraint if exists ct_ai_styles_prompt_check;
alter table flexiprint.ct_ai_styles add constraint ct_ai_styles_prompt_check check (char_length(prompt) between 1 and 12000);
