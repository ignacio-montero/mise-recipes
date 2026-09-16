// Caption fixtures.
//
// These are INLINE fixtures, never fetched. A suite that needs Instagram to be
// up is not a suite: it fails on a plane, it fails in CI, and when it does fail
// you cannot tell whether the code broke or the platform did.
//
// SHRIMP_TACO_CAPTION reproduces the shape of the reel used as the measured
// fixture in docs/RESEARCH-extraction.md §3 (shortcode C9dO9AevUQx — "nine
// ingredients with quantities/units/notes and nine steps", emoji bullets,
// a hashtag block). The exact bytes of a third-party caption are not stored in
// the repo, so this is reconstructed to the documented structure; what the
// tests assert about it are structural properties (it is obviously recipe-
// shaped), which is what the heuristic actually measures.

export const SHRIMP_TACO_CAPTION = `Crispy Shrimp Tacos 🌮🔥 the ones you keep asking for!

INGREDIENTS
- 1 lb shrimp, peeled and deveined
- 1 cup all purpose flour
- 1/2 cup cornstarch
- 1 tsp smoked paprika
- 1/2 tsp cayenne
- 2 cups vegetable oil for frying
- 8 corn tortillas
- 1/4 cup mayo
- 2 tbsp hot sauce

METHOD
1. Pat the shrimp completely dry.
2. Combine the flour, cornstarch, paprika and cayenne in a bowl.
3. Toss the shrimp in the dry mix until coated.
4. Heat the oil in a deep skillet to 180C.
5. Fry the shrimp in batches for 2 minutes a side.
6. Drain on a rack, not paper.
7. Whisk the mayo and hot sauce together.
8. Char the tortillas directly over the flame.
9. Serve with the sauce and a squeeze of lime.

Makes 6-8 tacos 🙌

#shrimptacos #tacotuesday #easyrecipes #foodreels #dinnerideas #seafood`;

/** The negative case: engagement bait with no recipe in it at all. */
export const LINK_IN_BIO_CAPTION = `You guys asked and I delivered 🙌🙌🙌

Full recipe is in my bio!! Link in bio 👆 go get it before it's gone

#food #foodie #foodporn #instafood #yum #dinner #tasty #reels #viral #explore
#foodblogger #eeeeeats #homecooking #cheflife #delicious #hungry #nomnom`;

/** A caption that mentions food but is a restaurant review, not a recipe. */
export const RESTAURANT_REVIEW_CAPTION = `Went to the new place on Brick Lane last night and honestly?
Best tacos I have had in London, no notes. The shrimp one is unreal and the
room is gorgeous. Booked out for weeks so plan ahead. Swipe for the room 👀`;
