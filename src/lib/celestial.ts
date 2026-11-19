import * as THREE from "three";

const DEG = Math.PI / 180;
const LATITUDE = 20.59;
const LONGITUDE = 78.96;

export interface CelestialState {
  sun: THREE.Vector3;
  moon: THREE.Vector3;
  sunElevation: number;
  daylight: number;
  moonlight: number;
}

const wrapDegrees = (value: number) => ((value % 360) + 360) % 360;
const wrapRadians = (value: number) => Math.atan2(Math.sin(value), Math.cos(value));
const smooth = (a: number, b: number, value: number) => {
  const t = THREE.MathUtils.clamp((value - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

function julianDay(date: Date): number {
  return date.getTime() / 86400000 + 2440587.5;
}

function siderealAngle(jd: number, t: number): number {
  const degrees = wrapDegrees(280.46061837 + 360.98564736629 * (jd - 2451545)
    + 0.000387933 * t * t - t * t * t / 38710000 + LONGITUDE);
  return degrees * DEG;
}

function horizontalDirection(rightAscension: number, declination: number, sidereal: number): THREE.Vector3 {
  const hourAngle = wrapRadians(sidereal - rightAscension);
  const latitude = LATITUDE * DEG;
  const east = -Math.cos(declination) * Math.sin(hourAngle);
  const north = Math.sin(declination) * Math.cos(latitude)
    - Math.cos(declination) * Math.cos(hourAngle) * Math.sin(latitude);
  const up = Math.sin(declination) * Math.sin(latitude)
    + Math.cos(declination) * Math.cos(hourAngle) * Math.cos(latitude);
  return new THREE.Vector3(east, up, -north).normalize();
}

function solarCoordinates(jd: number) {
  const t = (jd - 2451545) / 36525;
  const meanLongitude = wrapDegrees(280.46646 + t * (36000.76983 + t * 0.0003032));
  const meanAnomaly = (357.52911 + t * (35999.05029 - 0.0001537 * t)) * DEG;
  const equationCenter = Math.sin(meanAnomaly) * (1.914602 - t * (0.004817 + 0.000014 * t))
    + Math.sin(2 * meanAnomaly) * (0.019993 - 0.000101 * t)
    + Math.sin(3 * meanAnomaly) * 0.000289;
  const omega = (125.04 - 1934.136 * t) * DEG;
  const longitude = (meanLongitude + equationCenter - 0.00569 - 0.00478 * Math.sin(omega)) * DEG;
  const obliquity = (23 + (26 + (21.448 - t * (46.815 + t * (0.00059 - t * 0.001813))) / 60) / 60
    + 0.00256 * Math.cos(omega)) * DEG;
  return {
    rightAscension: Math.atan2(Math.cos(obliquity) * Math.sin(longitude), Math.cos(longitude)),
    declination: Math.asin(Math.sin(obliquity) * Math.sin(longitude)),
    t,
  };
}

function lunarCoordinates(jd: number) {
  const days = jd - 2451543.5;
  const node = (125.1228 - 0.0529538083 * days) * DEG;
  const inclination = 5.1454 * DEG;
  const periapsis = (318.0634 + 0.1643573223 * days) * DEG;
  const eccentricity = 0.0549;
  const meanAnomaly = (115.3654 + 13.0649929509 * days) * DEG;
  const eccentricAnomaly = meanAnomaly + eccentricity * Math.sin(meanAnomaly) * (1 + eccentricity * Math.cos(meanAnomaly));
  const xv = Math.cos(eccentricAnomaly) - eccentricity;
  const yv = Math.sqrt(1 - eccentricity * eccentricity) * Math.sin(eccentricAnomaly);
  const trueAnomaly = Math.atan2(yv, xv);
  const radius = Math.hypot(xv, yv);
  const argument = trueAnomaly + periapsis;
  const x = radius * (Math.cos(node) * Math.cos(argument) - Math.sin(node) * Math.sin(argument) * Math.cos(inclination));
  const y = radius * (Math.sin(node) * Math.cos(argument) + Math.cos(node) * Math.sin(argument) * Math.cos(inclination));
  const z = radius * Math.sin(argument) * Math.sin(inclination);
  const obliquity = (23.4393 - 3.563e-7 * days) * DEG;
  const equatorialY = y * Math.cos(obliquity) - z * Math.sin(obliquity);
  const equatorialZ = y * Math.sin(obliquity) + z * Math.cos(obliquity);
  return {
    rightAscension: Math.atan2(equatorialY, x),
    declination: Math.atan2(equatorialZ, Math.hypot(x, equatorialY)),
  };
}

/** Approximate Sun and Moon directions for central India; world +X is east and -Z is north. */
export function getCelestialState(date: Date): CelestialState {
  const jd = julianDay(date), t = (jd - 2451545) / 36525, sidereal = siderealAngle(jd, t);
  const sunCoordinates = solarCoordinates(jd);
  const moonCoordinates = lunarCoordinates(jd);
  const sun = horizontalDirection(sunCoordinates.rightAscension, sunCoordinates.declination, sidereal);
  const moon = horizontalDirection(moonCoordinates.rightAscension, moonCoordinates.declination, sidereal);
  const daylight = smooth(-0.12, 0.16, sun.y);
  const illumination = (1 - sun.dot(moon)) * 0.5;
  const moonlight = (1 - daylight) * smooth(-0.08, 0.08, moon.y) * illumination;
  return { sun, moon, sunElevation: Math.asin(THREE.MathUtils.clamp(sun.y, -1, 1)), daylight, moonlight };
}

export function formatIST(date: Date): string {
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
}
