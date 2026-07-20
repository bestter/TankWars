const regex = /^https:\/\/[a-zA-Z0-9-]+\.tankwars\.pages\.dev$/;
console.log(regex.test("https://evil.tankwars.pages.dev"));
console.log(regex.test("javascript:alert(1);//.tankwars.pages.dev"));
