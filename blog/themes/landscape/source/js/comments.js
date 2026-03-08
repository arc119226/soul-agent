/**
 * Blog comment system — safe DOM manipulation (no raw HTML injection)
 */
(function () {
  'use strict';

  var listEl = document.getElementById('comment-list');
  if (!listEl) return;

  var slug = listEl.getAttribute('data-slug');
  var apiBase = '/api/comments/' + encodeURIComponent(slug);

  // ── Helpers ──

  function formatDate(iso) {
    var d = new Date(iso);
    return d.toLocaleDateString('zh-TW', {
      year: 'numeric', month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit'
    });
  }

  function el(tag, className, textContent) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (textContent) node.textContent = textContent;
    return node;
  }

  // ── Build a comment DOM node (safe — no raw HTML) ──

  function buildComment(c) {
    var isAI = c.ai_replied === 1;
    var item = el('div', 'comment-item' + (isAI ? ' ai-reply' : ''));

    // Header row
    var header = el('div', 'comment-header');
    var author = el('span', 'comment-author', c.author_name);
    if (isAI) {
      var badge = el('span', 'ai-badge', 'AI');
      author.appendChild(badge);
    }
    var date = el('span', 'comment-date', formatDate(c.created_at));
    header.appendChild(author);
    header.appendChild(date);
    item.appendChild(header);

    // Content — textContent is safe, use white-space: pre-wrap for newlines
    var content = el('div', 'comment-content', c.content);
    item.appendChild(content);

    // Threaded replies
    if (c.replies && c.replies.length > 0) {
      var repliesWrap = el('div', 'comment-replies');
      c.replies.forEach(function (r) {
        repliesWrap.appendChild(buildComment(r));
      });
      item.appendChild(repliesWrap);
    }

    return item;
  }

  // ── Load comments ──

  function loadComments() {
    fetch(apiBase)
      .then(function (r) { return r.json(); })
      .then(function (data) {
        // Clear loading text
        while (listEl.firstChild) listEl.removeChild(listEl.firstChild);

        if (!data.comments || data.comments.length === 0) {
          listEl.appendChild(el('p', 'no-comments', '還沒有留言，來當第一個吧！'));
          return;
        }

        data.comments.forEach(function (c) {
          listEl.appendChild(buildComment(c));
        });
      })
      .catch(function () {
        while (listEl.firstChild) listEl.removeChild(listEl.firstChild);
        listEl.appendChild(el('p', 'no-comments', '留言載入失敗'));
      });
  }

  // ── Submit handler ──

  var form = document.getElementById('comment-form');
  if (form) {
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var btn = document.getElementById('comment-submit');
      var statusEl = document.getElementById('comment-status');
      var nameVal = form.author_name.value.trim();
      var contentVal = form.content.value.trim();

      if (!nameVal || !contentVal) return;

      btn.disabled = true;
      btn.textContent = '送出中...';
      statusEl.textContent = '';
      statusEl.className = '';

      var payload = { author_name: nameVal, content: contentVal };
      var emailVal = form.author_email.value.trim();
      if (emailVal) payload.author_email = emailVal;

      fetch(apiBase, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      })
        .then(function (r) {
          return r.json().then(function (d) { return { ok: r.ok, data: d }; });
        })
        .then(function (res) {
          if (res.ok && res.data.success) {
            statusEl.textContent = '留言成功！感謝你的分享';
            statusEl.className = 'success';
            form.content.value = '';
            loadComments();
          } else {
            statusEl.textContent = res.data.error || '留言失敗，請稍後再試';
            statusEl.className = 'error';
          }
        })
        .catch(function () {
          statusEl.textContent = '網路錯誤，請稍後再試';
          statusEl.className = 'error';
        })
        .finally(function () {
          btn.disabled = false;
          btn.textContent = '送出留言';
        });
    });
  }

  // Initial load
  loadComments();
})();
