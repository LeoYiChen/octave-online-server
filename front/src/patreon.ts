/*
 * Copyright © 2020, Octave Online LLC
 *
 * This file is part of Octave Online Server.
 *
 * Octave Online Server is free software: you can redistribute it and/or
 * modify it under the terms of the GNU Affero General Public License as
 * published by the Free Software Foundation, either version 3 of the License,
 * or (at your option) any later version.
 *
 * Octave Online Server is distributed in the hope that it will be useful, but
 * WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY
 * or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public
 * License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with Octave Online Server.  If not, see
 * <https://www.gnu.org/licenses/>.
 */

import Crypto = require("crypto");

import Async = require("async");
import EasyNoPassword = require("easy-no-password");
import SimpleOAuth2 = require("simple-oauth2");

// Can't get these to work in my current version of TypeScript and Node.js
const got = require("got");

import { config, logger } from "./shared_wrap";
import { User, IUser } from "./user_model";

interface PatreonPhase1AsyncAuto {
	enp: string;
	raw_user: IUser|null;
	user: IUser;
	resolve: any;
}

interface PatreonPhase2AsyncAuto {
	enp: boolean;
	raw_user: IUser|null;
	user: IUser;
	tokenObject: any;
	patreonInfo: {
		user_id: string;
		currently_entitled_amount_cents: number;
		currently_entitled_tier: string|null;
	};
	existingUser: IUser|null;
	resolve: any;
}

interface PatreonRevokeAsyncAuto {
	raw_user: IUser|null;
	user: IUser;
	revoke: any;
	resolve: any;
}

const log = logger("patreon");

const oauth2 = SimpleOAuth2.create({
	client: {
		id: config.patreon.client_id,
		secret: config.patreon.client_secret
	},
	auth: {
		tokenHost: "https://www.patreon.com",
		tokenPath: "/api/oauth2/token",
		authorizePath: "/oauth2/authorize"
	}
});

const scope = "identity";

// Use EasyNoPassword to create CSRF tokens for OAuth
const enp = EasyNoPassword(config.patreon.state_secret, config.patreon.state_max_token_age);

export function phase1(req: any, res: any, next: any) {
	Async.auto<PatreonPhase1AsyncAuto>({
		raw_user: (_next) => {
			const sess = req.session;
			const userId = sess && sess.passport && sess.passport.user;

			if (userId) User.findById(userId, _next);
			else _next(null, null);
		},
		user: ["raw_user", ({raw_user}, _next) => {
			if (!raw_user) {
				res.status(400).send("<h1>You must be logged in to perform this action</h1>");
			} else if (raw_user.patreon && raw_user.patreon.user_id && !raw_user.patreon.currently_entitled_tier) {
				log.trace("Patreon already linked", raw_user.consoleText, raw_user.patreon);
				res.redirect(config.patreon.login_redirect);
			} else {
				_next(null, raw_user);
			}
		}],
		enp: ["user", ({}, _next) => {
			// Don't perform further work until we determine the user exists
			enp.createToken(req.session.id, _next);
		}],
		resolve: ["enp", "user", ({enp, user}, _next) => {
			log.trace("Patreon phase 1", user.consoleText, req.session.id, enp);
			const authorizationUri = oauth2.authorizationCode.authorizeURL({
				redirect_uri: config.patreon.redirect_url,
				scope,
				state: enp
			});
			res.redirect(authorizationUri);
		}],
	}, (err: any) => {
		if (err) {
			log.error("PATREON PHASE 1 ERROR", err, err.options);
		}
		next(err);
	});
}

export function phase2(req: any, res: any, next: any) {
	if (!req.query || !req.query.state || !req.query.code) {
		// Login failure? Link denied?
		res.redirect("/auth/failure");
		return;
	}
	Async.auto<PatreonPhase2AsyncAuto>({
		raw_user: (_next) => {
			const sess = req.session;
			const userId = sess && sess.passport && sess.passport.user;

			if (userId) User.findById(userId, _next);
			else _next(null, null);
		},
		user: ["raw_user", ({raw_user}, _next) => {
			if (!raw_user) {
				res.status(400).send("<h1>You must be logged in to perform this action</h1>");
			} else {
				_next(null, raw_user);
			}
		}],
		enp: ["user", ({}, _next) => {
			// Don't perform further work until we determine the user exists
			enp.isValid(req.query.state, req.session.id, _next);
		}],
		tokenObject: ["enp", ({enp}, _next) => {
			if (!enp) {
				log.warn("Patreon callback: invalid state", req.session.id, JSON.stringify(req.session));
				res.redirect("/auth/failure");
			} else {
				log.info("Patreon callback: valid state");
				oauth2.authorizationCode.getToken({
					redirect_uri: config.patreon.redirect_url,
					code: req.query.code,
					scope
				}).then((result) => {
					log.debug("Success getting token!");
					_next(null, result);
				}).catch((err) => {
					log.debug("Failure getting token!", err);
					_next(err);
				});
			}
		}],
		patreonInfo: ["tokenObject", ({tokenObject}, _next) => {
			log.trace(tokenObject);
			got("https://www.patreon.com/api/oauth2/v2/identity", {
				headers: {
					"Authorization": "Bearer " + tokenObject.access_token
				},
				query: {
					"include": "memberships,memberships.currently_entitled_tiers",
					"fields[member]": "currently_entitled_amount_cents"
				},
				json: true
			}).then((response: any) => {
				const body = response.body;
				try {
					const user_id = (body.data.id) as string;
					const memberships = body.data.relationships.memberships.data;
					const membership = (memberships.length > 0) ? body.included[0] : null;
					if (membership && membership.type !== "member") {
						log.error("ERROR: Expected first include to be the membership");
						res.status(500).send("<h1>Unexpected error; please contact support</h1>");
						return;
					}
					const currently_entitled_amount_cents = membership ? (membership.attributes.currently_entitled_amount_cents) as number : 0;
					const tiers = membership ? membership.relationships.currently_entitled_tiers.data : [];
					const currently_entitled_tier = (tiers.length > 0) ? (tiers[0].id as string) : null;
					if (!currently_entitled_tier && currently_entitled_amount_cents > 0) {
						log.warn("No tier, but pledge is > 0:", JSON.stringify(body));
					}
					_next(null, {
						user_id,
						currently_entitled_tier,
						currently_entitled_amount_cents,
					});
				} catch(e) {
					log.error("Invalid identity response:", JSON.stringify(body));
					_next(e);
				}
			}).catch(_next);
		}],
		existingUser: ["patreonInfo", ({patreonInfo}, _next) => {
			User.findOne({ "patreon.user_id": patreonInfo.user_id }, _next);
		}],
		resolve: ["user", "tokenObject", "patreonInfo", "existingUser", ({user, tokenObject, patreonInfo, existingUser}, _next) => {
			log.info("Patreon Resolved", user.consoleText, JSON.stringify(patreonInfo));
			if (existingUser && !existingUser._id.equals(user._id)) {
				log.warn("Different existing user. Old user:", existingUser.consoleText, "New user:", user.consoleText);
				res.status(400).render("patreon_link_error", {
					user_id: patreonInfo.user_id,
					old_email: existingUser.email,
					new_email: user.email,
					config
				});
				return;
			}

			// All good. Save the Patreon link to MongoDB.
			const accessToken = oauth2.accessToken.create(tokenObject);
			user.patreon = { oauth2: accessToken.token, ...patreonInfo };
			user.save().then(() => {
				if (patreonInfo.currently_entitled_tier) {
					log.info("Linked account already pledged");
					res.redirect("/");
				} else {
					log.info("Redirecting to Patreon to pledge");
					res.redirect(config.patreon.login_redirect);
				}
			}).catch(_next);
		}]
	}, (err: any) => {
		if (err) {
			log.error("PATREON PHASE 2 ERROR", err, err.options);
		}
		next(err);
	});
}

export function revoke(req: any, res: any, next: any) {
	Async.auto<PatreonRevokeAsyncAuto>({
		raw_user: (_next) => {
			const sess = req.session;
			const userId = sess && sess.passport && sess.passport.user;

			if (userId) User.findById(userId, _next);
			else _next(null, null);
		},
		user: ["raw_user", ({raw_user}, _next) => {
			if (!raw_user) {
				res.status(400).send("<h1>You must be logged in to perform this action</h1>");
			} else if (!raw_user.patreon) {
				res.status(400).send("<h1>Your Patreon account is not linked</h1>");
			} else {
				_next(null, raw_user);
			}
		}],
		revoke: ["user", ({user}, _next) => {
			log.info("Patreon Revoke", user.consoleText);
			// TODO: Figure out how to actually revoke the tokens on demand. They will eventually time out. The following code causes an error on the Patreon response: "The content-type is not JSON compatible"
			/*
			const accessToken = oauth2.accessToken.create(user.patreon.oauth2);
			accessToken.revokeAll().then(() => {
				_next(null);
			}).catch(_next);
			*/
			_next(null);
		}],
		resolve: ["user", "revoke", ({user}, _next) => {
			user.patreon = undefined;
			user.save().then(() => {
				res.redirect("/");
			}).catch(_next);
		}],
	}, (err: any) => {
		if (err) {
			log.error("PATREON REVOKE ERROR", err, err.options);
		}
		next(err);
	});
}

export function webhook(req: any, res: any, next: any) {
	const event = req.headers["x-patreon-event"];
	const data = req.body ? req.body : req.query;

	// Verify the signature
	const hmac = Crypto.createHmac("md5", config.patreon.webhook_secret);
	hmac.update(req.rawBody);
	const expectedSignature = hmac.digest("hex");
	if (expectedSignature === req.headers["x-patreon-signature"]) {
		log.trace("Webhook signature matches");
	} else {
		log.warn("Patreon Webhook: Unexpected Signature", req.headers["x-patreon-signature"], data);
		res.sendStatus(412);
		return;
	}

	log.info("Webhook", event, data);
	log.info("Webhook", data.included);
	res.sendStatus(204);
}
