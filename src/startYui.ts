// 開場角色：第一次打開時（這台瀏覽器）把畫面上的角色換成結衣，只做一次。之後你在「人物」換成誰，都照你的選擇記住。
// 不改 game/tutor.ts 的預設值（DEFAULT_TUTOR 還是むぎ），所以原本的測試不受影響。
import { loadTutor, selectCharacter, writeTutor } from './game/tutor';

const FLAG = 'mugi.startYui.v1';

export function startWithYuiOnce() {
  try {
    if (localStorage.getItem(FLAG)) return;
    writeTutor(selectCharacter(loadTutor(), 'yui'));
    localStorage.setItem(FLAG, '1');
  } catch { /* private mode: nothing is saved anyway */ }
}
