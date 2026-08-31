import hero from '../assets/character-hero.png'
import panel from '../assets/character-panel.png'

const ART = [hero, panel]

export const characterArt = ART[Math.floor(Math.random() * ART.length)] ?? panel
