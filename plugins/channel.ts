/**
 * Channel plugin — manage and post to @your-channel.
 *
 * Subcommands:
 *   channel post <text>     — Post custom text to the channel
 *   channel blog <slug>     — Cross-post a blog article to the channel
 *   channel status          — Show channel config and referral status
 *   channel referrals       — List all referral links
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Plugin } from '../src/plugins/plugin-api.js';

const REFERRAL_PATH = join(process.cwd(), 'soul', 'config', 'referral.json');

const HELP_TEXT = `📢 **頻道管理**

**子指令：**
• \`channel post <文字>\` — 手動發文到頻道（HTML 格式）
• \`channel blog <slug>\` — 發布部落格文章到頻道
• \`channel status\` — 顯示頻道設定
• \`channel referrals\` — 顯示聯盟連結`;

const plugin: Plugin = {
  meta: {
    name: 'channel',
    description: '頻道管理 — 發文到 @your-channel',
    icon: '📢',
    aliases: ['channel', '頻道', 'ch'],
  },

  handler: async (ctx, args) => {
    const parts = args.trim().split(/\s+/);
    const sub = parts[0]?.toLowerCase() || '';
    const rest = parts.slice(1).join(' ').trim();

    // Resolve channel ID from config (dynamic import to avoid circular deps)
    let channelId = '@your-channel';
    try {
      const { config } = await import('../src/config.js');
      channelId = config.TELEGRAM_CHANNEL_ID || '@your-channel';
    } catch { /* use default */ }

    switch (sub) {
      case 'post':
      case '發文': {
        if (!rest) {
          await ctx.sendMarkdown('用法：`channel post <文字>`\n\n文字會以 HTML 格式發送到頻道。');
          return;
        }
        try {
          await ctx.bot.api.sendMessage(channelId, rest, { parse_mode: 'HTML' });
          await ctx.sendMarkdown(`✅ 已發文到 ${channelId}`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          await ctx.sendMarkdown(`❌ 發文失敗：${msg}`);
        }
        return;
      }

      case 'blog': {
        if (!rest) {
          await ctx.sendMarkdown('用法：`channel blog <slug>`\n\n例：`channel blog ai-agent-architecture`');
          return;
        }
        await ctx.sendMarkdown(`⏳ 正在格式化 \`${rest}\`...`);
        try {
          const { formatChannelPost } = await import('../src/blog/channel-publisher.js');
          const text = await formatChannelPost(rest);
          if (!text) {
            await ctx.sendMarkdown(`❌ 找不到文章 \`${rest}\`，請確認 slug 正確。\n\n文章應在 \`blog/source/_posts/\` 目錄下。`);
            return;
          }
          // We need the Bot instance (not BotContext) to call postToChannel.
          // Use ctx.bot.api directly instead.
          await ctx.bot.api.sendMessage(channelId, text, {
            parse_mode: 'HTML',
            link_preview_options: { is_disabled: false },
          });
          await ctx.sendMarkdown(`✅ 已將 \`${rest}\` 發布到 ${channelId}`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          await ctx.sendMarkdown(`❌ 發布失敗：${msg}`);
        }
        return;
      }

      case 'status': {
        const lines = [
          '📢 **頻道狀態**',
          '',
          `頻道：\`${channelId}\``,
          '',
        ];

        try {
          const raw = await readFile(REFERRAL_PATH, 'utf-8');
          const data = JSON.parse(raw) as { referrals: Array<{ name: string; active: boolean }> };
          const active = data.referrals.filter((r) => r.active);
          lines.push(`聯盟連結：${active.length} 個啟用中`);
          for (const r of active) {
            lines.push(`  • ${r.name} ✅`);
          }
        } catch {
          lines.push('聯盟連結：尚未設定');
        }

        await ctx.sendMarkdown(lines.join('\n'));
        return;
      }

      case 'referrals':
      case '聯盟': {
        try {
          const raw = await readFile(REFERRAL_PATH, 'utf-8');
          const data = JSON.parse(raw) as {
            referrals: Array<{ name: string; url: string; bonus: string; tags: string[]; active: boolean }>;
          };
          const lines = ['💱 **聯盟連結設定**', ''];
          for (const r of data.referrals) {
            const status = r.active ? '✅' : '❌';
            lines.push(`${status} **${r.name}**`);
            lines.push(`   ${r.bonus}`);
            lines.push(`   標籤：${r.tags.join(', ')}`);
            lines.push('');
          }
          await ctx.sendMarkdown(lines.join('\n'));
        } catch {
          await ctx.sendMarkdown('❌ 無法讀取 `soul/config/referral.json`');
        }
        return;
      }

      default:
        await ctx.sendMarkdown(HELP_TEXT);
    }
  },
};

export default plugin;
