/**
 * Simple Blog Search
 * 基於 hexo-generator-searchdb 生成的 search.xml
 * XSS-safe implementation using DOM methods
 */

(function() {
  'use strict';

  let searchData = null;

  // DOM 元素
  const searchButton = document.getElementById('search-button');
  const searchModal = document.getElementById('search-modal');
  const searchClose = document.getElementById('search-close');
  const searchInput = document.getElementById('search-input');
  const searchResults = document.getElementById('search-results');

  if (!searchButton || !searchModal || !searchInput || !searchResults) {
    return; // 如果元素不存在，直接退出
  }

  // 載入搜尋資料
  function loadSearchData() {
    if (searchData) {
      return Promise.resolve(searchData);
    }

    return fetch('/search.xml')
      .then(response => response.text())
      .then(text => {
        const parser = new DOMParser();
        const xml = parser.parseFromString(text, 'text/xml');
        const entries = xml.querySelectorAll('entry');

        searchData = Array.from(entries).map(entry => ({
          title: entry.querySelector('title')?.textContent || '',
          content: entry.querySelector('content')?.textContent || '',
          url: entry.querySelector('url')?.textContent || '',
          date: entry.querySelector('date')?.textContent || ''
        }));

        return searchData;
      })
      .catch(err => {
        console.error('Failed to load search data:', err);
        return [];
      });
  }

  // 搜尋函數
  function search(keyword) {
    if (!keyword || keyword.trim() === '') {
      return [];
    }

    keyword = keyword.toLowerCase().trim();
    const keywords = keyword.split(/\s+/);

    return searchData.filter(post => {
      const title = post.title.toLowerCase();
      const content = post.content.toLowerCase();

      // 所有關鍵字都要匹配
      return keywords.every(kw => {
        return title.includes(kw) || content.includes(kw);
      });
    }).map(post => {
      // 計算相關度分數（標題匹配權重更高）
      let score = 0;
      keywords.forEach(kw => {
        if (post.title.toLowerCase().includes(kw)) score += 10;
        if (post.content.toLowerCase().includes(kw)) score += 1;
      });

      // 提取摘要（包含關鍵字的片段）
      const excerpt = extractExcerpt(post.content, keywords[0]);

      return {
        ...post,
        score,
        excerpt,
        keyword: keywords[0]
      };
    }).sort((a, b) => b.score - a.score);
  }

  // 提取包含關鍵字的摘要
  function extractExcerpt(content, keyword, maxLength = 150) {
    const lowerContent = content.toLowerCase();
    const lowerKeyword = keyword.toLowerCase();
    const index = lowerContent.indexOf(lowerKeyword);

    if (index === -1) {
      return content.substring(0, maxLength) + '...';
    }

    const start = Math.max(0, index - 50);
    const end = Math.min(content.length, index + keyword.length + 100);
    let excerpt = content.substring(start, end);

    if (start > 0) excerpt = '...' + excerpt;
    if (end < content.length) excerpt = excerpt + '...';

    return excerpt;
  }

  // 高亮關鍵字（安全方法）
  function highlightKeyword(text, keyword) {
    const fragment = document.createDocumentFragment();
    const lowerText = text.toLowerCase();
    const lowerKeyword = keyword.toLowerCase();
    let lastIndex = 0;

    let index = lowerText.indexOf(lowerKeyword);
    while (index !== -1) {
      // 添加關鍵字前的文字
      if (index > lastIndex) {
        fragment.appendChild(document.createTextNode(text.substring(lastIndex, index)));
      }

      // 添加高亮的關鍵字
      const mark = document.createElement('mark');
      mark.textContent = text.substring(index, index + keyword.length);
      fragment.appendChild(mark);

      lastIndex = index + keyword.length;
      index = lowerText.indexOf(lowerKeyword, lastIndex);
    }

    // 添加剩餘文字
    if (lastIndex < text.length) {
      fragment.appendChild(document.createTextNode(text.substring(lastIndex)));
    }

    return fragment;
  }

  // 渲染搜尋結果（XSS-safe）
  function renderResults(results) {
    // 清空結果
    searchResults.textContent = '';

    if (results.length === 0) {
      const p = document.createElement('p');
      p.className = 'search-no-results';
      p.textContent = '沒有找到相關文章';
      searchResults.appendChild(p);
      return;
    }

    results.forEach(post => {
      const item = document.createElement('div');
      item.className = 'search-result-item';

      // 標題連結
      const link = document.createElement('a');
      link.href = post.url;
      link.className = 'search-result-title';
      link.textContent = post.title;
      item.appendChild(link);

      // 摘要（帶高亮）
      const excerpt = document.createElement('p');
      excerpt.className = 'search-result-excerpt';
      excerpt.appendChild(highlightKeyword(post.excerpt, post.keyword));
      item.appendChild(excerpt);

      // 日期
      const time = document.createElement('time');
      time.className = 'search-result-date';
      time.textContent = new Date(post.date).toLocaleDateString('zh-TW');
      item.appendChild(time);

      searchResults.appendChild(item);
    });
  }

  // 執行搜尋
  function performSearch() {
    const keyword = searchInput.value;

    if (!keyword || keyword.trim() === '') {
      searchResults.textContent = '';
      const p = document.createElement('p');
      p.className = 'search-hint';
      p.textContent = '輸入關鍵字開始搜尋';
      searchResults.appendChild(p);
      return;
    }

    loadSearchData().then(() => {
      const results = search(keyword);
      renderResults(results);
    });
  }

  // 開啟搜尋 Modal
  function openSearch() {
    searchModal.style.display = 'flex';
    searchInput.focus();
    loadSearchData(); // 預先載入資料
  }

  // 關閉搜尋 Modal
  function closeSearch() {
    searchModal.style.display = 'none';
    searchInput.value = '';
    searchResults.textContent = '';
    const p = document.createElement('p');
    p.className = 'search-hint';
    p.textContent = '輸入關鍵字開始搜尋';
    searchResults.appendChild(p);
  }

  // 事件監聽
  searchButton.addEventListener('click', openSearch);
  searchClose.addEventListener('click', closeSearch);

  // 按 ESC 鍵關閉
  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape' && searchModal.style.display !== 'none') {
      closeSearch();
    }
  });

  // 點擊 Modal 背景關閉
  searchModal.addEventListener('click', function(e) {
    if (e.target === searchModal) {
      closeSearch();
    }
  });

  // 輸入時即時搜尋（防抖）
  let debounceTimer;
  searchInput.addEventListener('input', function() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(performSearch, 300);
  });

  // Enter 鍵搜尋
  searchInput.addEventListener('keydown', function(e) {
    if (e.key === 'Enter') {
      performSearch();
    }
  });
})();
