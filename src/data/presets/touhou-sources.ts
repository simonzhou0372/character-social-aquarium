export const TOUHOU_CATALOG = 'touhou-canon-2026-10';
export const TOUHOU_AS_OF = '2026-10-24';
export interface TouhouSource {
  title: string;
  url: string;
  original: string;
  kind: 'official' | 'primary-transcript' | 'work-index';
}
const omake = (title: string, file: string): TouhouSource => ({
  title,
  original: `ZUN／上海爱丽丝幻乐团《${title}》原作附带文档`,
  url: `https://omake.thwiki.cc/translate/${encodeURIComponent(file)}.zh.txt`,
  kind: 'primary-transcript',
});
const book = (title: string, page: string): TouhouSource => ({
  title,
  original: `ZUN 原作《${title}》；索引用于定位作品和章节，不以百科推测为原设`,
  url: `https://thwiki.cc/${encodeURIComponent(page)}`,
  kind: 'work-index',
});
export const touhouSources: Record<string, TouhouSource> = {
  overview: {
    title: '东方Project 官方作品介绍',
    original: '东方Projectよもやまニュース，ZUN 的作品介绍',
    url: 'https://touhou-project.news/touhou_project/',
    kind: 'official',
  },
  guideline: {
    title: '东方Project 创作使用指南',
    original: '上海爱丽丝幻乐团／东方Projectよもやまニュース',
    url: 'https://touhou-project.news/guideline/',
    kind: 'official',
  },
  th01: omake('东方灵异传', '东方灵异传_manual'),
  th02: omake('东方封魔录', '东方封魔录_manual'),
  th03: omake('东方梦时空', '东方梦时空_omake'),
  th03manual: omake('东方梦时空说明书', '东方梦时空_manual'),
  th04: omake('东方幻想乡', '东方幻想乡_omake'),
  th05: omake('东方怪绮谈', '东方怪绮谈_omake'),
  th06: omake('东方红魔乡', '东方红魔乡_omake'),
  th07: omake('东方妖妖梦', '东方妖妖梦_角色设定'),
  th075: omake('东方萃梦想', '东方萃梦想_上海爱丽丝通信'),
  th08: omake('东方永夜抄', '东方永夜抄_角色设定'),
  th09: omake('东方花映塚', '东方花映塚_角色设定'),
  th10: omake('东方风神录', '东方风神录_角色设定'),
  th105: omake('东方绯想天', '东方绯想天_omake'),
  th11: omake('东方地灵殿', '东方地灵殿_角色设定'),
  th12: omake('东方星莲船', '东方星莲船_角色设定_exstory'),
  th125: omake('东方文花帖DS', '东方文花帖ds_omake'),
  th128: omake('妖精大战争', '妖精大战争_游戏内manual'),
  th13: omake('东方神灵庙', '东方神灵庙_角色设定_exstory'),
  th135: omake('东方心绮楼', '东方心绮楼_omake'),
  th14: omake('东方辉针城', '东方辉针城_omake'),
  th143: omake('弹幕天邪鬼', '弹幕天邪鬼_omake'),
  th145: omake('东方深秘录', '东方深秘录_omake'),
  th15: omake('东方绀珠传', '东方绀珠传_omake'),
  th155: omake('东方凭依华', '东方凭依华_omake'),
  th16: omake('东方天空璋', '东方天空璋_omake'),
  th165: omake('秘封噩梦日记', '秘封噩梦日记_omake'),
  th17: omake('东方鬼形兽', '东方鬼形兽_omake'),
  th175: omake('东方刚欲异闻', '东方刚欲异闻_omake'),
  th18: omake('东方虹龙洞', '东方虹龙洞_omake'),
  th185: omake('弹幕狂们的黑市', '弹幕狂们的黑市_omake'),
  th19: omake('东方兽王园', '东方兽王园_omake'),
  th19dialogue: book('东方兽王园剧情模式', '东方兽王园/剧情'),
  th20: omake('东方锦上京', '东方锦上京_omake'),
  pmiss: book('东方求闻史纪', '东方求闻史纪'),
  symposium: book('东方求闻口授', '东方求闻口授'),
  fairies: book('东方三月精', '东方三月精/公式站角色介绍'),
  curiosities: book('东方香霖堂', '东方香霖堂'),
  moon: book('东方儚月抄', '东方儚月抄 ～ Cage in Lunatic Runagate./设定文档'),
  scrollery: book('东方铃奈庵', '东方铃奈庵'),
  kasen: {
    title: '东方茨歌仙官方人物介绍',
    original: '一迅社／ZUN 原作《东方茨歌仙》',
    url: 'https://www.ichijinsha.co.jp/special/toho_ibarakasen/',
    kind: 'official',
  },
  kasenFinal: book('东方茨歌仙第49～50话', '东方茨歌仙'),
  lotus: book('东方醉蝶华', '东方醉蝶华'),
  detective: book('东方智灵奇传', '东方智灵奇传/设定资料图'),
  cd: book('莲台野夜行／秘封俱乐部', '莲台野夜行/附带故事'),
};
