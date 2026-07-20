function testOrigin(rawOrigin) {
    const isAllowedOrigin = rawOrigin === 'https://tankwars.pages.dev' ||
      /^https:\/\/[a-zA-Z0-9-]+\.tankwars\.pages\.dev$/.test(rawOrigin) ||
      /^http:\/\/localhost:\d+$/.test(rawOrigin) ||
      /^http:\/\/127\.0\.0\.1:\d+$/.test(rawOrigin);
    return isAllowedOrigin ? rawOrigin : 'https://tankwars.pages.dev';
}
console.log(testOrigin("javascript:alert(1)"));
console.log(testOrigin("https://tankwars.pages.dev"));
console.log(testOrigin("http://localhost:5173"));
console.log(testOrigin("https://1234.tankwars.pages.dev"));
