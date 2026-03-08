/**
 * /blog command — Manage the AI blog from Telegram.
 *
 * Usage:
 *   /blog              — Dashboard: recent posts + quick actions
 *   /blog list         — All posts (published + drafts)
 *   /blog new [title]  — Create a new draft
 *   /blog publish [slug] — Publish a draft
 *   /blog deploy       — Deploy to Cloudflare Pages
 *   /blog comments [slug] — View comments for a post
 *   /blog stats        — Blog statistics
 *
 * Callbacks:
 *   blog:list          — Show all posts
 *   blog:deploy        — Trigger deploy
 *   blog:comments:slug — View comments for slug
 *   blog:publish:slug  — Publish a draft
 */

import { InlineKeyboard } from 'grammy';
import { commandRegistry } from '../telegram/command-registry.js';
import { sendLongMessage } from '../telegram/helpers.js';
import type { BotContext } from '../bot.js';
import { upsertPost, publishPost, getPostStats } from '../blog/post-store.js';
import { createDraft, moveDraftToPost, listDrafts, listPosts } from '../blog/hexo-manager.js';
import { getComments, getLatestComments } from '../blog/comment-client.js';
import { deployBlog } from '../blog/deploy-workflow.js';
import { config } from '../config.js';

// ── Dashboard ───────────────────────────────────────────────────────

async function showDashboard(ctx: BotContext): Promise<void> {
  const stats = await getPostStats();
  const drafts = await listDrafts();
  const posts = await listPosts();

  const lines = [
    '📝 *Blog Dashboard*',
    '',
    `🌐 ${config.BLOG_URL}`,
    `📄 已發布: ${stats.totalPosts} 篇`,
    `📋 草稿: ${drafts.length} 篇`,
  ];

  if (stats.lastPublished) {
    const d = new Date(stats.lastPublished);
    lines.push(`🕐 最近發布: ${d.toLocaleDateString('zh-TW', { timeZone: 'Asia/Taipei' })}`);
  }

  // Show recent posts
  if (posts.length > 0) {
    lines.push('', '── 最近文章 ──');
    const recent = posts.slice(0, 3);
    recent.forEach(slug => {
      lines.push(`  • ${slug}`);
    });
  }

  // Show drafts
  if (drafts.length > 0) {
    lines.push('', '── 待發布草稿 ──');
    drafts.forEach(slug => {
      lines.push(`  • ${slug}`);
    });
  }

  const keyboard = new InlineKeyboard()
    .text('📋 所有文章', 'blog:list')
    .text('🚀 部署', 'blog:deploy')
    .row()
    .text('💬 最新留言', 'blog:recent-comments')
    .text('📊 統計', 'blog:stats');

  const text = lines.join('\n');
  try {
    await ctx.reply(text, { parse_mode: 'Markdown', reply_markup: keyboard });
  } catch {
    await ctx.reply(text.replace(/[*_]/g, ''), { reply_markup: keyboard });
  }
}

// ── List ─────────────────────────────────────────────────────────────

async function showList(ctx: BotContext): Promise<void> {
  const posts = await listPosts();
  const drafts = await listDrafts();

  const lines = ['📋 *文章列表*', ''];

  if (posts.length > 0) {
    lines.push('── 已發布 ──');
    posts.forEach(slug => {
      lines.push(`  ✅ ${slug}`);
    });
  }

  if (drafts.length > 0) {
    lines.push('', '── 草稿 ──');
    drafts.forEach(slug => {
      lines.push(`  📝 ${slug}`);
    });
  }

  if (posts.length === 0 && drafts.length === 0) {
    lines.push('目前沒有文章。使用 /blog new [標題] 建立新文章。');
  }

  // Build keyboard for drafts (publish buttons)
  const keyboard = new InlineKeyboard();
  drafts.slice(0, 4).forEach(slug => {
    keyboard.text(`🚀 發布 ${slug.slice(0, 20)}`, `blog:publish:${slug}`).row();
  });
  keyboard.text('🏠 返回', 'blog:home');

  const text = lines.join('\n');
  try {
    await ctx.reply(text, { parse_mode: 'Markdown', reply_markup: keyboard });
  } catch {
    await ctx.reply(text.replace(/[*_]/g, ''), { reply_markup: keyboard });
  }
}

// ── New Draft ─────────────────────────────────────────────────────────

async function handleNew(ctx: BotContext, title: string): Promise<void> {
  if (!title) {
    await ctx.reply('請提供標題: /blog new 我的新文章');
    return;
  }

  const result = await createDraft(title, `\n<!-- 在這裡寫你的文章 -->\n`);

  if (result.ok) {
    // Track in post store
    await upsertPost({
      slug: result.slug!,
      title,
      date: new Date().toISOString().slice(0, 10),
      status: 'draft',
      categories: [],
      tags: [],
      wordCount: 0,
      createdBy: 'command',
    });

    const keyboard = new InlineKeyboard()
      .text('🚀 發布', `blog:publish:${result.slug}`)
      .text('🏠 返回', 'blog:home');

    await ctx.reply(`✅ 草稿已建立: ${result.slug}\n\n路徑: blog/source/_drafts/${result.slug}.md`, { reply_markup: keyboard });
  } else {
    await ctx.reply(`❌ ${result.message}`);
  }
}

// ── Publish ──────────────────────────────────────────────────────────

async function handlePublish(ctx: BotContext, slug: string): Promise<void> {
  if (!slug) {
    const drafts = await listDrafts();
    if (drafts.length === 0) {
      await ctx.reply('目前沒有草稿。使用 /blog new [標題] 建立新草稿。');
      return;
    }
    const keyboard = new InlineKeyboard();
    drafts.forEach(d => {
      keyboard.text(`🚀 ${d}`, `blog:publish:${d}`).row();
    });
    await ctx.reply('選擇要發布的草稿：', { reply_markup: keyboard });
    return;
  }

  await ctx.reply(`⏳ 正在發布 ${slug}...`);

  // Move file
  const moveResult = await moveDraftToPost(slug);
  if (!moveResult.ok) {
    await ctx.reply(`❌ ${moveResult.message}`);
    return;
  }

  // Update post store
  await publishPost(slug);

  // Deploy
  const deployResult = await deployBlog();
  if (deployResult.ok) {
    await ctx.reply(`✅ 文章已發布並部署！\n\n🌐 ${config.BLOG_URL}`);
  } else {
    await ctx.reply(`⚠️ 文章已移動但部署失敗: ${deployResult.message}\n\n使用 /blog deploy 重試。`);
  }
}

// ── Deploy ───────────────────────────────────────────────────────────

async function handleDeploy(ctx: BotContext): Promise<void> {
  await ctx.reply('⏳ 正在部署...');
  const result = await deployBlog();
  if (result.ok) {
    await ctx.reply(`✅ ${result.message}\n\n🌐 ${result.url}`);
  } else {
    await ctx.reply(`❌ ${result.message}`);
  }
}

// ── Comments ─────────────────────────────────────────────────────────

async function showComments(ctx: BotContext, slug: string): Promise<void> {
  if (!slug) {
    // Show latest comments across all posts
    const latest = await getLatestComments('24h', 10);
    if (latest.count === 0) {
      await ctx.reply('最近 24 小時沒有新留言。');
      return;
    }

    const lines = [`💬 *最新留言* (${latest.count} 條)`, ''];
    latest.comments.forEach(c => {
      const time = new Date(c.created_at).toLocaleString('zh-TW', {
        timeZone: 'Asia/Taipei',
        month: 'short', day: 'numeric',
        hour: '2-digit', minute: '2-digit',
      });
      const badge = c.ai_replied ? ' [AI]' : '';
      lines.push(`📌 ${c.post_slug}`);
      lines.push(`  ${c.author_name}${badge} (${time})`);
      lines.push(`  ${c.content.slice(0, 100)}${c.content.length > 100 ? '...' : ''}`);
      lines.push('');
    });

    await sendLongMessage(ctx, ctx.chat!.id, lines.join('\n'));
    return;
  }

  // Show comments for specific post
  const data = await getComments(slug);
  if (data.count === 0) {
    await ctx.reply(`📝 ${slug} 還沒有留言。`);
    return;
  }

  const lines = [`💬 *${slug}* 的留言 (${data.count} 條)`, ''];
  data.comments.forEach(c => {
    const time = new Date(c.created_at).toLocaleString('zh-TW', {
      timeZone: 'Asia/Taipei',
      month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
    lines.push(`${c.author_name} (${time})`);
    lines.push(`  ${c.content.slice(0, 150)}`);
    if (c.replies?.length) {
      c.replies.forEach(r => {
        const badge = r.ai_replied ? ' [AI]' : '';
        lines.push(`  ↳ ${r.author_name}${badge}: ${r.content.slice(0, 100)}`);
      });
    }
    lines.push('');
  });

  await sendLongMessage(ctx, ctx.chat!.id, lines.join('\n'));
}

// ── Stats ────────────────────────────────────────────────────────────

async function showStats(ctx: BotContext): Promise<void> {
  const stats = await getPostStats();
  const posts = await listPosts();
  const drafts = await listDrafts();
  const latest = await getLatestComments('7d', 100);

  const lines = [
    '📊 *Blog 統計*',
    '',
    `📄 已發布: ${posts.length} 篇`,
    `📋 草稿: ${drafts.length} 篇`,
    `💬 7 日留言: ${latest.count} 條`,
    `🌐 ${config.BLOG_URL}`,
  ];

  if (stats.lastPublished) {
    lines.push(`🕐 最近發布: ${new Date(stats.lastPublished).toLocaleDateString('zh-TW', { timeZone: 'Asia/Taipei' })}`);
  }

  const text = lines.join('\n');
  try {
    await ctx.reply(text, { parse_mode: 'Markdown' });
  } catch {
    await ctx.reply(text.replace(/[*_]/g, ''));
  }
}

// ── Registration ─────────────────────────────────────────────────────

/** Blog handler — handles args from /blog or /content blog */
export async function handleBlog(ctx: Parameters<typeof showDashboard>[0]): Promise<void> {
  const text = ctx.message?.text || '';
  const args = text.replace(/^\/(?:content\s+)?blog\s*/i, '').trim();

  if (!args) {
    await showDashboard(ctx);
  } else if (args === 'list' || args === '列表') {
    await showList(ctx);
  } else if (args.startsWith('new ') || args.startsWith('新增 ')) {
    const title = args.replace(/^(?:new|新增)\s+/, '');
    await handleNew(ctx, title);
  } else if (args.startsWith('publish ') || args.startsWith('發布 ')) {
    const slug = args.replace(/^(?:publish|發布)\s+/, '');
    await handlePublish(ctx, slug);
  } else if (args === 'publish' || args === '發布') {
    await handlePublish(ctx, '');
  } else if (args === 'deploy' || args === '部署') {
    await handleDeploy(ctx);
  } else if (args.startsWith('comments ') || args.startsWith('留言 ')) {
    const slug = args.replace(/^(?:comments|留言)\s+/, '');
    await showComments(ctx, slug);
  } else if (args === 'comments' || args === '留言') {
    await showComments(ctx, '');
  } else if (args === 'stats' || args === '統計') {
    await showStats(ctx);
  } else {
    await showDashboard(ctx);
  }
}

/** Register blog callback handlers (called from content.ts) */
export function registerBlogCallbacks(): void {
  commandRegistry.registerCallback('blog:home', async (ctx) => {
    await showDashboard(ctx);
  });

  commandRegistry.registerCallback('blog:list', async (ctx) => {
    await showList(ctx);
  });

  commandRegistry.registerCallback('blog:deploy', async (ctx) => {
    await handleDeploy(ctx);
  });

  commandRegistry.registerCallback('blog:stats', async (ctx) => {
    await showStats(ctx);
  });

  commandRegistry.registerCallback('blog:recent-comments', async (ctx) => {
    await showComments(ctx, '');
  });

  commandRegistry.registerCallback('blog:publish:', async (ctx, data) => {
    await handlePublish(ctx, data);
  });

  commandRegistry.registerCallback('blog:comments:', async (ctx, data) => {
    await showComments(ctx, data);
  });
}
