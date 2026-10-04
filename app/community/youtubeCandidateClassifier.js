const INTENTS = Object.freeze(["QUESTION", "OPINION", "JOKE", "PRAISE", "CONSTRUCTIVE_CRITICISM", "TOXIC", "SPAM_SCAM", "SENSITIVE", "CONTENT_SEED", "NO_REPLY"]);
function classifyYouTubeCandidate(event = {}) {
  const text = String(event.text || "").trim();
  const meta = event.metadata || {};
  const result = (intent, action, reason, contentSeed = false) => ({ intent, action, reason, contentSeed });
  if (meta.isTopLevel !== true) return result("NO_REPLY", "HUMAN_REVIEW", "SIBLING_REPLY_REQUIRES_REVIEW");
  if (meta.creatorReplied) return result("NO_REPLY", "SKIP", "CREATOR_ALREADY_ANSWERED");
  if (!text || !/[\p{L}\p{N}]/u.test(text) || /^(first|первый|перший|ок|ok|lol|thanks|спасибо|дякую)[!. ]*$/iu.test(text)) return result("NO_REPLY", "SKIP", "NO_REPLY_NEEDED");
  if (/(https?:\/\/|www\.|t\.me\/|bit\.ly|\b(?:telegram|whatsapp|crypto|giveaway|subscribe to me)\b|бесплатн.*(?:ключ|деньг)|подпиш.*на меня)/iu.test(text)) return result("SPAM_SCAM", "HUMAN_REVIEW", "LINK_PROMOTION_OR_SCAM");
  if (/(kill yourself|kys|i will kill|убью|сдохни|ненавижу тебя|you are (?:an? )?(?:idiot|moron)|ты идиот)/iu.test(text)) return result("TOXIC", "HUMAN_REVIEW", "THREAT_OR_ABUSE");
  if (/(\b(?:lawsuit|fraud|criminal|rapist|politic|election|medical|diagnos|suicid|depress|medication|cancer|traffick)\w*|мошенник|преступник|насил|выборы|политик|лекарств|диагноз|самоубий|депресси)/iu.test(text)) return result("SENSITIVE", "HUMAN_REVIEW", "SENSITIVE_OR_ALLEGATION");
  if (/(system prompt|ignore (?:all|previous)|api key|access token|системн.*промпт|игнорируй.*инструкц|ты (?:бот|ии)|are you (?:a bot|ai))/iu.test(text)) return result("SENSITIVE", "HUMAN_REVIEW", "AMBIGUOUS_OR_AUTOMATION_CONTEXT");
  const seed = /(make (?:a )?(?:video|short)|next video|разбери|сними|сделай.*(?:ролик|видео)|зніми|розбери)/iu.test(text);
  if (seed) return result("CONTENT_SEED", "DRAFT", "CONTENT_IDEA", true);
  if (/[?？]/u.test(text)) return result("QUESTION", "DRAFT", "QUESTION");
  if (/(слишком|тише|громк|субтитр|не слышно|too (?:loud|quiet|fast)|captions|hard to hear|повільн|швидко)/iu.test(text)) return result("CONSTRUCTIVE_CRITICISM", "DRAFT", "CONSTRUCTIVE_FEEDBACK");
  if (/(аха|haha|lol|😂|🤣|шутк|жарт)/iu.test(text)) return result("JOKE", "DRAFT", "JOKE");
  if (/(круто|класс|супер|топ|чудово|awesome|great|love this|nice|well done)/iu.test(text)) return result("PRAISE", "DRAFT", "PRAISE");
  if (text.length < 12) return result("NO_REPLY", "HUMAN_REVIEW", "AMBIGUOUS_CONTEXT");
  return result("OPINION", "DRAFT", "OPINION");
}
module.exports = { INTENTS, classifyYouTubeCandidate };
