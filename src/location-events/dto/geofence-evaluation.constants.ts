/**
 * Serialization rule for the GF-5 point-in-circle evaluation contract.
 *
 * PostGIS returns `ST_Distance` over geography as a double precision value in
 * meters. Emitting that raw double would make the response depend on the last
 * bits of a spheroid computation, so every distance is rounded to a fixed
 * number of decimal places for output only.
 *
 * Three places is a millimeter. It is far finer than any GNSS fix the ingestion
 * contract accepts (`accuracyMeters` is reported in whole-ish meters) and far
 * coarser than the noise floor of the geodesic computation, so it is stable
 * across runs without discarding anything a caller could use.
 *
 * Rounding is applied strictly after the database has decided containment. The
 * containment predicate compares the unrounded `ST_Distance` against the
 * unrounded radius, so no geofence is matched or missed because of this rule — a
 * point 0.0004 m outside a circle is still excluded even though its distance
 * serializes to the same value as the radius.
 */
export const EVALUATION_DISTANCE_DECIMAL_PLACES = 3;
