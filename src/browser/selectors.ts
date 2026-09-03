export const loginSelectors = {
  email: "#user_email",
  password: "#user_password",
  signIn: "input[value='Sign in']",
} as const;

export const hr = "(//div[contains(@class,'Countdown')]//td)[1]";
export const min = "(//div[contains(@class,'Countdown')]//td)[3]";
export const sec = "(//div[contains(@class,'Countdown')]//td)[5]";

export const bookingSelectors = {
  frame: "iframe[src*='greenfield.playbypoint.com']",
  bookNow: "//span[normalize-space()='Book Now']/ancestor::button[1]",
  reserveFullCourt: "//span[contains(text(),'Reserve a full court')]/ancestor::button",
  next: "//span[text()='Next']",
  typePickleball: "//button[text()='Pickleball']",
  nextCourt: "(//span[contains(text(),'Next')]/ancestor::button)[1]",
  addUser: "//button[text()='Add Users']",
  nextUser: "(//span[contains(text(),'Next')]/ancestor::button)[2]",
  book: "//button[text()='Book']",
  selectDateTime: "//h2[text()='Select date and time']",
  confirmationNumber: "//div[text()='Confirmation Number']/following-sibling::div",
  bookingTimer: "//*[contains(normalize-space(text()), 'Booking for this day will open in:')]",
  hr,
  min,
  sec,
} as const;
