export const loginSelectors = {
  email: "#user_email",
  password: "#user_password",
  signIn: "input[value='Sign in']",
} as const;

export const bookingSelectors = {
  frame: "iframe[src*='greenfield.playbypoint.com']",
  bookNow: "//span[normalize-space()='Book Now']/ancestor::button[1]",
  reserveFullCourt: "//span[contains(text(),'Reserve a full court')]/ancestor::button",
  next: "//span[text()='Next']",
  typePickleball: "//button[text()='Pickleball']",
} as const;
