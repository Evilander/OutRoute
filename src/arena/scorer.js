import { getEloRating, updateEloRating, getAllEloRatings, getDb } from '../db/store.js';

const K_NEW = 32;
const K_ESTABLISHED = 16;
const ESTABLISHED_THRESHOLD = 30;

export function calculateNewRatings(winnerRating, loserRating, k = K_NEW) {
  const expectedWinner = 1 / (1 + Math.pow(10, (loserRating - winnerRating) / 400));
  const expectedLoser = 1 / (1 + Math.pow(10, (winnerRating - loserRating) / 400));

  const newWinnerRating = Math.round((winnerRating + k * (1 - expectedWinner)) * 100) / 100;
  const newLoserRating = Math.round((loserRating + k * (0 - expectedLoser)) * 100) / 100;

  return { newWinnerRating, newLoserRating };
}

export function recordVote(winnerId, loserId, taskType = 'general') {
  const db = getDb();
  const txn = db.transaction(() => {
    const winnerElo = getEloRating(winnerId, taskType);
    const loserElo = getEloRating(loserId, taskType);

    const kWinner = winnerElo.battles < ESTABLISHED_THRESHOLD ? K_NEW : K_ESTABLISHED;
    const kLoser = loserElo.battles < ESTABLISHED_THRESHOLD ? K_NEW : K_ESTABLISHED;

    const expectedWinner = 1 / (1 + Math.pow(10, (loserElo.rating - winnerElo.rating) / 400));
    const expectedLoser = 1 / (1 + Math.pow(10, (winnerElo.rating - loserElo.rating) / 400));

    const newWinnerRating = Math.round((winnerElo.rating + kWinner * (1 - expectedWinner)) * 100) / 100;
    const newLoserRating = Math.round((loserElo.rating + kLoser * (0 - expectedLoser)) * 100) / 100;

    updateEloRating(winnerId, taskType, newWinnerRating, true);
    updateEloRating(loserId, taskType, newLoserRating, false);

    return { newWinnerRating, newLoserRating };
  });
  return txn();
}

export function getLeaderboard(taskType) {
  let ratings = getAllEloRatings();

  if (taskType) {
    ratings = ratings.filter(r => r.task_type === taskType);
  }

  return ratings
    .sort((a, b) => b.rating - a.rating)
    .map(r => ({
      model: r.model,
      rating: r.rating,
      wins: r.wins,
      losses: r.losses,
      battles: r.battles,
      winRate: r.battles > 0 ? Math.round((r.wins / r.battles) * 10000) / 100 : 0,
      taskType: r.task_type,
    }));
}
