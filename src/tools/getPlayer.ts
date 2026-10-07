import { z } from "zod";
import { LICHESS, type LichessClient, type LichessUser } from "../lichess.js";
import { iso, ok, truncate, usernameSchema } from "./common.js";

export const getPlayerInput = { username: usernameSchema };

const ratingOutput = z.object({
  perf: z.string().describe("bullet, blitz, rapid, classical, correspondence, chess960, puzzle, ..."),
  rating: z.number(),
  games: z.number(),
  provisional: z.boolean().describe("True when Lichess marks the rating as provisional (too few recent games)."),
  recent_change: z.number().optional().describe("Rating progress over the last 12 games."),
});

export const getPlayerOutput = {
  username: z.string(),
  url: z.string(),
  title: z.string().optional().describe("GM, IM, FM, CM, NM, WGM, ..., LM, BOT"),
  account_status: z.enum(["active", "closed", "tos_violation"]),
  created_at: z.string().optional(),
  last_seen_at: z.string().optional(),
  patron: z.boolean(),
  ratings: z.array(ratingOutput).describe("Rated speeds and variants the player has actually played, most games first."),
  puzzle_modes: z
    .array(z.object({ mode: z.string(), runs: z.number(), best_score: z.number() }))
    .describe("Puzzle Storm / Racer / Streak high scores."),
  games: z
    .object({ all: z.number(), rated: z.number(), wins: z.number(), losses: z.number(), draws: z.number() })
    .optional(),
  play_time_hours: z.number().optional(),
  profile: z
    .object({
      real_name: z.string().optional(),
      bio: z.string().optional(),
      flag: z.string().optional(),
      location: z.string().optional(),
      fide_rating: z.number().optional(),
    })
    .optional(),
};

export async function getPlayer(client: LichessClient, args: { username: string }) {
  const user = (await client.getJson<LichessUser>(`${LICHESS}/api/user/${encodeURIComponent(args.username)}`, {
    notFound: `No Lichess player named '${args.username}'.`,
    notFoundHint: "Check the spelling; usernames are case-insensitive but must be exact otherwise.",
    auth: false,
  }))!;

  const perfs = user.perfs ?? {};
  const ratings = Object.entries(perfs)
    .filter(([, p]) => typeof p.rating === "number" && (p.games ?? 0) > 0)
    .map(([perf, p]) => ({
      perf,
      rating: p.rating!,
      games: p.games ?? 0,
      provisional: Boolean(p.prov),
      ...(typeof p.prog === "number" && p.prog !== 0 ? { recent_change: p.prog } : {}),
    }))
    .sort((a, b) => b.games - a.games);

  const puzzleModes = (["storm", "racer", "streak"] as const)
    .filter((m) => typeof perfs[m]?.runs === "number")
    .map((m) => ({ mode: m, runs: perfs[m]!.runs!, best_score: perfs[m]!.score ?? 0 }));

  const status = user.tosViolation ? "tos_violation" : user.disabled || user.closed ? "closed" : "active";
  const profile = user.profile
    ? {
        real_name: truncate(user.profile.realName, 80),
        bio: truncate(user.profile.bio, 300),
        flag: user.profile.flag,
        location: truncate(user.profile.location, 80),
        fide_rating: user.profile.fideRating,
      }
    : undefined;
  const hasProfile = profile && Object.values(profile).some((v) => v !== undefined);

  return ok({
    username: user.username,
    url: user.url ?? `${LICHESS}/@/${user.username}`,
    ...(user.title ? { title: user.title } : {}),
    account_status: status,
    created_at: iso(user.createdAt),
    last_seen_at: iso(user.seenAt),
    patron: Boolean(user.patron),
    ratings,
    puzzle_modes: puzzleModes,
    ...(user.count
      ? {
          games: {
            all: user.count.all ?? 0,
            rated: user.count.rated ?? 0,
            wins: user.count.win ?? 0,
            losses: user.count.loss ?? 0,
            draws: user.count.draw ?? 0,
          },
        }
      : {}),
    ...(user.playTime?.total ? { play_time_hours: Math.round(user.playTime.total / 360) / 10 } : {}),
    ...(hasProfile ? { profile } : {}),
  });
}

export const getPlayerDescription =
  "Look up a Lichess player: title, ratings for each speed they play (bullet, blitz, rapid, classical, puzzles, variants) with game counts and provisional flags, win/loss/draw totals, and basic profile info.";
