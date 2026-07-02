//__KaanKoçak___HungryBat_OOP___02_26_2021//
//HochschuleDarmstadt____ExpandedRealities//
//FundamentalsOfTechnology1__FinalHomeWork//

/*

//Default Mode //level1

 
 Bugs:
 //2 Player mode makes a conflict on prey colorings.
 Might be better to count preys together and levelup the players together.
 //On 2 players mode there could be a competition on counting preys.
 E.g. even a player dies, the one with higher prey score wins.
 //Even if you can not eat the collided preys they dissapear sometimes (rarely).
 //I wanted to make an array list of counted preys to show them after every level up.
 Which is why i am printing collided encounters.
 But for now I am not taking it any further.
 I left the code inside in case I use it later.
 
 // I made all the animations in Photoshop.
 // I made all the sounds in FamiStudio including music.
 
 //Slide animations added. /They should not loop
 //Idle returns almost like it restarts. /On other levels it is lagging because I could not restart it.
 */


import processing.sound.*;
import gifAnimation.*;

Player Bat1;
Player Bat2;
Encounter Grounds;

int [] DemoLevel = { 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1,1, 1, 1, 1, 1, 1, 2, 2,2, 2,  100, 100, 100, 100, 101, 101, 101 };
//int [] Level1 = { 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 100, 100, 100, 100 };
//int [] Level2 = {  0, 1, 1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 2, 100, 100, 100, 100, 100, 100, 101 };
//int [] Level3 = { 0, 0, 0, 0, 0, 1, 1, 1, 2, 2, 2, 100, 100, 100, 100, 100, 101, 101, 101 };

int PlayerSwitch=1;

Encounter[] EncArray = new Encounter[1000];    //How many interactable encounters?
//Encounter[][] Counted = new Encounter[5][5];  //Created this to display after each level.

float EncDensity=.15;    //Distance between interactable encounters.

int E;    //Randomizer // Using this for level reinitializations.


void setup() {
  size(650, 1000); //Flexible Screen Size Min:600 Max:800 
  CreateImported();  //

  // Initialize Level1
  for (int i = 0; i<EncArray.length; i++) {
    E = (int)random(DemoLevel.length);
    EncArray[i] = new Encounter(random( width), height*2+(i*EncArray.length*EncDensity), DemoLevel[E]);
  }
  Bat1 = new Player();
  Bat2 = new Player();
  Grounds = new Encounter(0, EncArray.length-height*3, -4);
}


void draw() {
  background(100);
  frameRate(60);
  //Operate Encounter object in draw() by calling
  if (Bat1.StartController==1)
    Grounds.Move();
  Grounds.GroundDisp();

  switch (PlayerSwitch) {

  case 1: //One Player//
    // Run each Encounter using a for loop.  
    for (int i=0; i<EncArray.length; i++) {
      if (Bat1.StartController==1)
        EncArray[i].Move();
      EncArray[i].dispRank(Bat1);
      EncArray[i].display();
      Collider(Bat1, EncArray[i]);
    }
    if (Bat1.StartController==1) //End of the intro
      Bat1.Controller(1);
    //Player one
    IntroBG(Bat1);
    Bat1.DispShadow();
    Intro(Bat1);
    UInew(Bat1, 1);
    Bat1.PlayerCursor(1);
    EndCards();
    Bat1.Display();
    break;

  case 2: //Two Players//
    // Run each Encounter using a for loop.  
    for (int i=0; i<EncArray.length; i++) {
      if (Bat1.StartController==1)
        EncArray[i].Move();
      EncArray[i].dispRank(Bat1);
      EncArray[i].display();
      Collider(Bat1, EncArray[i]);
      Collider(Bat2, EncArray[i]);
    }
    if (Bat1.StartController==1) {  //End of the intro
      Bat1.Controller(1);
      Bat2.Controller(2);
    }
    //Players
    IntroBG(Bat1);
    Bat1.DispShadow();
    Bat2.DispShadow();
    Intro(Bat1);
    Intro(Bat2);

    UInew(Bat1, 1);
    UInew(Bat2, 2);

    EndCards();
    
    Bat2.PlayerCursor(2);
    Bat1.PlayerCursor(1);

    Bat1.Display();
    Bat2.Display();
    break;
  }

  FpsCounter();
}


void keyPressed() {  //Created for testing purposes.
  if (key == 'h' || key == 'H') {
    Bat1.Health=100;
  }
  if (key == '+') { //LevelUp
    Bat1.RankPlayer++;
  }
  if (key == 'x' || key == 'X') { //Kill
    Bat1.Health=-1;
  }
  if (key == 'r' || key == 'R') { //Restart //??
  }

  if (key == 'l' || key == 'L') { //initialize level2
    // Initialize each Encounter using a for loop.

    for (int i = 0; i<EncArray.length; i++) {
      E = (int)random(DemoLevel.length);

      EncArray[i] = new Encounter(random(width), height*2+(i*EncArray.length*EncDensity*.9), DemoLevel[E]);   //Respawn the level || or different level.
      EncArray[i].Speed=5;
      Grounds.Speed=5;
    }
  }
}





//might use later to counted preys
/*
  int En;
 void ArraySwitch() {
 int k=-1;
 int l=0;
 
 println(k+ " "+ l);
 if (!(k<6 && l<6)) { //Add new element to array
 k=k+1;
 if (k==5) {
 l=l+1;
 k=0;
 }
 
 }
 
 pushMatrix();
 int col=75; 
 int row=75;
 int a =1;
 translate(width/2-(Counted.length*col-col)/2, height/2-(Counted.length*row-row)/2);
 for (int i=0; i< Counted.length; i++) {
 for (int j=0; j< Counted[0].length; j++) {
 //Counted
 
 //rect(i*col, j*row, col, row);
 Counted[i][j]= new Encounter(i*col, j*row, -2); //(int)random(3)
 Counted[2][1]= new Encounter(i*col, j*row, a); //(int)random(3)
 
 Counted[i][j].display();
 }
 }
 popMatrix();
 }
 */
